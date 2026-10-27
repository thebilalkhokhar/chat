// Every HTTP request: dashboard, API and SalesIQ webhooks. Built by `npm run build` into dist/.
module.exports = (req, res) => require("../dist/vercel").app(req, res);
