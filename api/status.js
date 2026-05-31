const express = require("express");
const router = express.Router();

router.get("/:job_id", (req, res) => {
  const { job_id } = req.params;
  global.jobs = global.jobs || {};
  const job = global.jobs[job_id];
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  return res.json(job);
});

module.exports = router;
