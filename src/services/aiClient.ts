import OpenAI from "openai";
import { config } from "../config/env";
import type { ISettings } from "../models/Settings";

export interface ProviderCandidate {
  name: "openai" | "custom";
  label: string;
  apiKey: string;
  baseURL?: string;
  model: string;
}

/**
 * Builds the ordered candidate list of AI providers to try based on active settings.
 *
 * OpenAI, and a custom endpoint for anyone who configures one.
 *
 * Gemini used to lead this cascade and was removed rather than nursed along.
 * The model name went stale and 404'd every call; the replacement rate-limited
 * under real volume; and finally it stopped being reachable from Railway inside
 * six seconds at all — fine from anywhere else, so nothing looked broken —
 * which put every turn over the ten seconds SalesIQ allows and had fourteen
 * customers in one day told the bot would come back to them shortly instead of
 * being asked a question. Three separate failures, one provider, all of them
 * paid for in latency on the customer's side.
 *
 * NVIDIA used to sit between them and was removed rather than repaired. Its
 * model had been retired — every call answered 410 — and so had every
 * replacement offered by the account's own catalogue: four different ids, all
 * 404 or 410. A provider that cannot be called is not a fallback, it is two
 * wasted round trips in front of the one that works, and on a slow minute those
 * are what pushed a turn past the ten seconds SalesIQ allows.
 */
/**
 * How long any one provider may take before the cascade moves on.
 *
 * Sized against SalesIQ's patience, not against what a model might want. It
 * waits about ten seconds and then tells the visitor the bot failed.
 *
 * A safety net rather than a step in the normal path: with one provider left
 * and gpt-5-nano answering in one to three seconds, nothing healthy comes close
 * to this. It exists so a hung connection cannot eat the whole ten seconds
 * SalesIQ allows before it declares the bot failed.
 */
const PROVIDER_TIMEOUT_MS = 6000;

export function getProviderCandidates(settings?: ISettings): ProviderCandidate[] {
  // "auto" is gone. It read as "we choose for you" and meant "the environment
  // chooses, and the model on the dashboard is ignored" — which is how a
  // dashboard saying gpt-5-nano sat over an environment running something else.
  const selected = settings?.ai?.provider === "custom" ? "custom" : "openai";

  const openaiCandidate: ProviderCandidate = {
    name: "openai",
    label: "OpenAI / ChatGPT",
    apiKey: settings?.ai?.openaiApiKey?.trim() || (selected === "openai" ? settings?.ai?.apiKey?.trim() : "") || config.openai.apiKey || process.env.OPENAI_API_KEY || "",
    baseURL: (selected === "openai" && settings?.ai?.baseURL?.trim()) || config.openai.baseURL || "https://api.openai.com/v1",
    model: (selected === "openai" && settings?.ai?.model?.trim()) || config.openai.model || "gpt-5-nano",
  };

  const customCandidate: ProviderCandidate = {
    name: "custom",
    label: "Custom Endpoint",
    apiKey: settings?.ai?.apiKey?.trim() || config.openai.apiKey || "",
    baseURL: settings?.ai?.baseURL?.trim() || undefined,
    model: settings?.ai?.model?.trim() || "gpt-5-nano",
  };

  let list: ProviderCandidate[] = [];

  // "auto" and "openai" are the same thing now that OpenAI is the only
  // provider; "custom" puts a configured endpoint in front of it.
  list = selected === "custom" ? [customCandidate, openaiCandidate] : [openaiCandidate];

  // Filter out candidates that have no API key configured (unless custom with no key)
  const valid = list.filter((p) => Boolean(p.apiKey) || (p.name === "custom" && Boolean(p.baseURL)));

  // If none have keys, return all candidates so an informative error will be surfaced
  return valid.length > 0 ? valid : list;
}

/**
 * Providers that keep failing, and when to bother with them again.
 *
 * A cascade only helps if the first provider usually answers. When it stops
 * answering entirely, trying it first is not resilience — it is a fixed tax on
 * every single call, paid in the one currency that matters here: SalesIQ gives
 * the bot about ten seconds before telling the visitor it failed.
 *
 * That is not hypothetical either. Gemini went unreachable from Railway — fine
 * from anywhere else, so nothing was "down" in a way a status page would show —
 * and every call spent the full timeout on it before the fallback answered in
 * two seconds. A hundred and one calls, a hundred and one timeouts, turns
 * running fourteen seconds, and fourteen real customers told "I have your
 * details and will come back to you shortly" instead of being asked a question.
 *
 * So a provider that fails repeatedly is set aside for a few minutes and the
 * cascade moves on. It is retried afterwards on its own, because the same
 * network that broke usually mends itself and nobody should have to notice.
 */
const CONSECUTIVE_FAILURES_BEFORE_SKIPPING = 3;
const SKIP_FOR_MS = 3 * 60_000;

const providerHealth = new Map<string, { failures: number; skipUntil: number }>();

function isSidelined(name: string): boolean {
  const health = providerHealth.get(name);
  return Boolean(health && health.skipUntil > Date.now());
}

function recordFailure(name: string, label: string): void {
  const health = providerHealth.get(name) || { failures: 0, skipUntil: 0 };
  health.failures += 1;

  if (health.failures >= CONSECUTIVE_FAILURES_BEFORE_SKIPPING) {
    health.skipUntil = Date.now() + SKIP_FOR_MS;
    health.failures = 0;
    console.warn(
      `[ai] ${label} failed ${CONSECUTIVE_FAILURES_BEFORE_SKIPPING} times running — skipping it for ${SKIP_FOR_MS / 60_000} minutes`
    );
  }

  providerHealth.set(name, health);
}

function recordSuccess(name: string): void {
  providerHealth.delete(name);
}

/**
 * Centralized completion function with automatic fallback.
 *
 * OpenAI, minus it if it is currently sidelined for failing repeatedly — in
 * which case it is tried anyway, being the last one standing.
 */
export async function createChatCompletion(
  params: Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model"> & { model?: string },
  settings?: ISettings,
  /**
   * What this call is for, named by the caller.
   *
   * Four places call this and the logs could not tell them apart: a slow turn
   * showed up as three anonymous entries and there was no way to know whether
   * the time went on reading the customer's message or writing the reply. It is
   * a plain string rather than a union so a new caller cannot be blocked by
   * forgetting to widen a type.
   */
  purpose = "unspecified"
): Promise<OpenAI.Chat.ChatCompletion> {
  const all = getProviderCandidates(settings);

  /**
   * Never sideline the last one standing.
   *
   * If every provider is failing, something larger is wrong and the right
   * answer is still to try — a call that fails is no worse than a call that was
   * never made, and skipping all of them would turn a degraded service into a
   * dead one.
   */
  const healthy = all.filter((candidate) => !isSidelined(candidate.name));
  const candidates = healthy.length > 0 ? healthy : all;

  const errors: Array<{ provider: string; model: string; error: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];

    if (!candidate.apiKey) {
      errors.push({
        provider: candidate.label,
        model: candidate.model,
        error: "No API key configured in settings or environment.",
      });
      continue;
    }

    const client = new OpenAI({
      apiKey: candidate.apiKey,
      baseURL: candidate.baseURL,
      /**
       * Bounded, because the caller is on a clock somebody else set.
       *
       * SalesIQ waits about ten seconds for the bot and then tells the visitor
       * it failed. The SDK's own default is no timeout and two silent retries,
       * so one slow provider could spend that entire budget three times over
       * before the next one in the cascade was even tried. The cascade is the
       * retry; this is the bound on each attempt in it.
       */
      timeout: PROVIDER_TIMEOUT_MS,
      maxRetries: 0,
    });

    // The candidate already carries the model this provider should use: the one
    // on the dashboard, or OPENAI_MODEL when that is blank.
    const modelToUse = candidate.model;

    /**
     * OpenAI's reasoning models — o1, o3, o4-mini, and the gpt-5 family
     * including gpt-5-nano — take a fixed temperature of 1 and 400 on anything
     * else. Every caller here sets 0.4 for consistency, which is right for a
     * chat model and wrong for a reasoning one, so it is stripped rather than
     * asking four call sites to know which model they happen to be talking to.
     *
     * `reasoning_effort: "minimal"` is set alongside it for the same reason the
     * per-provider timeout exists: the turn has a budget SalesIQ set, not one
     * this model would choose for itself. Minimal effort answered in 1.1s on a
     * test call against 3.6s at the default — the difference between comfortably
     * inside the budget and most of it gone on a call that only writes one
     * sentence.
     */
    const isReasoningModel = /^o[0-9]|^gpt-5(\.\d+)?(-mini|-nano|-pro)?(-\d{4}-\d{2}-\d{2})?$/i.test(
      modelToUse
    );

    const callParams = isReasoningModel
      ? {
          ...params,
          temperature: undefined,
          // The installed SDK's types only know "low" | "medium" | "high" —
          // "minimal" is newer than the type definitions but not newer than the
          // API, which accepts it and answers meaningfully faster for it: 1.6s
          // against 5.2s at the default on the same prompt. Hence the cast.
          reasoning_effort: "minimal" as unknown as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
        }
      : params;

    try {
      // First attempt with the specified params
      const startedAt = Date.now();
      const response = await client.chat.completions.create({
        ...callParams,
        model: modelToUse,
      });
      const tookMs = Date.now() - startedAt;

      /**
       * An empty answer is a failed answer, not a cheap one.
       *
       * A smaller model occasionally returns a completion with no content at
       * all — gemini-3.5-flash-lite did it on one of the four test turns. Every
       * caller here is parsing JSON out of that content, so an empty one throws
       * where the caller stands: mid-chat, which hands a live visitor to a
       * human over nothing. Treated as this provider failing means the next one
       * answers and the visitor never knows.
       */
      if (!response.choices?.[0]?.message?.content?.trim()) {
        throw new Error("returned an empty completion");
      }

      recordSuccess(candidate.name);

      /**
       * One line per call, carrying what it cost.
       *
       * `response.model` rather than the model asked for, because they are not
       * the same thing: "gpt-5-nano" is an alias and the API answers with the
       * build it actually ran — the day that repoints, this line is the only
       * place it will show.
       *
       * Token counts are here because nothing else in the service records them.
       * Cost and prompt size were both invisible: there was no way to tell a
       * turn that spent four thousand tokens of chat history from one that spent
       * four hundred, or to notice either growing.
       */
      const usage = response.usage;
      console.log(
        `[ai] ${purpose} | ${candidate.label} | ${response.model || modelToUse} | ${tookMs}ms | ` +
          `in ${usage?.prompt_tokens ?? "?"} out ${usage?.completion_tokens ?? "?"} total ${usage?.total_tokens ?? "?"} tok` +
          (i > 0 ? ` | fallback after ${i} failed provider(s)` : "")
      );

      return response;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[ai] ${purpose} | ${candidate.label} | ${modelToUse} | FAILED: ${errMsg}`);
      recordFailure(candidate.name, candidate.label);

      // If json_schema format caused a 400 rejection on a non-OpenAI provider, try falling back to json_object
      if (
        params.response_format &&
        (params.response_format as any).type === "json_schema" &&
        (errMsg.includes("schema") || errMsg.includes("response_format") || errMsg.includes("400"))
      ) {
        try {
          console.log(`[ai] ${purpose} | retrying ${candidate.label} with simplified json_object format`);
          const retryStartedAt = Date.now();
          const fallbackFormatResponse = await client.chat.completions.create({
            ...callParams,
            model: modelToUse,
            response_format: { type: "json_object" },
          });
          recordSuccess(candidate.name);

          const retryUsage = fallbackFormatResponse.usage;
          console.log(
            `[ai] ${purpose} | ${candidate.label} | ${fallbackFormatResponse.model || modelToUse} | ` +
              `${Date.now() - retryStartedAt}ms | in ${retryUsage?.prompt_tokens ?? "?"} out ${retryUsage?.completion_tokens ?? "?"} ` +
              `total ${retryUsage?.total_tokens ?? "?"} tok | json_object retry`
          );

          return fallbackFormatResponse;
        } catch (retryErr: any) {
          console.warn(
            `[ai] ${purpose} | ${candidate.label} | json_object retry also FAILED: ${retryErr?.message || retryErr}`
          );
        }
      }

      errors.push({
        provider: candidate.label,
        model: modelToUse,
        error: errMsg,
      });

      // Move to next candidate in cascade
    }
  }

  const details = errors.map((e) => `[${e.provider} / ${e.model}]: ${e.error}`).join(" | ");
  console.error(`[ai] ${purpose} | ALL PROVIDERS FAILED | ${details}`);
  throw new Error(`All AI providers failed: ${details}`);
}

/**
 * Backward compatibility helpers
 */
export function getAiClient(settings?: ISettings): OpenAI {
  const candidate = getProviderCandidates(settings)[0];
  return new OpenAI({
    apiKey: candidate?.apiKey || "unconfigured-api-key",
    baseURL: candidate?.baseURL,
  });
}

export function getAiModel(settings?: ISettings): string {
  const candidate = getProviderCandidates(settings)[0];
  return candidate?.model || "gpt-5-nano";
}
