// One worker pass, called by Vercel Cron every minute (see vercel.json).
module.exports = (req, res) => require("../../dist/vercel").cron(req, res);
