// Owner feedback on the assistant's answers and answers its checks held back (/admin/control), from the codes already recorded:
// no question, answer or customer detail is stored, so none can be shown. Real businesses only; test ones are counted apart.
import { isTestBusinessSql } from '../testbusiness.js'

export async function assistantQuality(db, now = Date.now(), days = 30) {
  const since = now - days * 86_400_000
  const real = `NOT ${isTestBusinessSql('e.customer')}`
  const [asked, reasons, checks, test] = await Promise.all([
    db.prepare(`SELECT count(*) AS n, coalesce(sum(json_extract(e.props,'$.ok') = 1), 0) AS ok, coalesce(sum(json_extract(e.props,'$.reason') = 'unchecked'), 0) AS held FROM events e WHERE e.type = 'ai_ask' AND e.at >= ?1 AND ${real}`).bind(since).first(),
    db.prepare(`SELECT json_extract(e.props,'$.reason') AS reason, json_extract(e.props,'$.view') AS view, count(*) AS n, max(e.at) AS last FROM events e WHERE e.type = 'ai_feedback' AND e.at >= ?1 AND ${real} GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`).bind(since).all(),
    db.prepare(`SELECT j.value AS code, count(*) AS n FROM events e, json_each(e.props, '$.refusals') j WHERE e.type = 'ai_ask' AND e.at >= ?1 AND ${real} GROUP BY 1 ORDER BY n DESC LIMIT 8`).bind(since).all(),
    db.prepare(`SELECT count(*) AS n FROM events e WHERE e.type = 'ai_feedback' AND e.at >= ?1 AND ${isTestBusinessSql('e.customer')}`).bind(since).first(),
  ])
  return { days, asked: asked.n, answered: asked.ok, heldBack: asked.held, feedback: reasons.results.map((r) => ({ reason: r.reason, view: r.view, count: r.n, last: r.last })), checks: checks.results.map((r) => ({ check: String(r.code).slice(0, 60), count: r.n })), testFeedback: test.n }
}
