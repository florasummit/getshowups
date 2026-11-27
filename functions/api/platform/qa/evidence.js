// POST /api/platform/qa/evidence { ownerKind: result|item, ownerId, kind, text? | url? | dataBase64? } — attach
// evidence (redacted text ≤ 8 KB, https link, or a screenshot ≤ 1 MB byte-sniffed as PNG/JPEG/WebP). Audited.
import { json } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaPost } from '../../../../server/ops/qa-route.js'
import { addEvidence } from '../../../../server/ops/qa-evidence.js'

export const onRequestPost = qaPost(
  async ({ env, body, admin, actor }) => {
    const r = await addEvidence(env.ONBOARDING_DB, { ownerKind: body.ownerKind, ownerId: body.ownerId, kind: body.kind, text: body.text, url: body.url, dataBase64: body.dataBase64, by: actor })
    if (r.error) return fail(r)
    await audit(env, admin.email, 'qa.evidence_added', null, { evidence: r.evidence.id, owner: `${body.ownerKind}:${body.ownerId}`, kind: r.evidence.kind, bytes: r.evidence.bytes })
    return json(201, r)
  },
  { maxBytes: 1_450_000 },
)
