// Website address: the GetShowUps address (default, nothing to do), your own domain (guided), or
// buying a new one (you own it; we point you to a registrar). Plain language; DNS details appear only
// for the one record the owner must add, with copy buttons.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Pill } from './ui.jsx'

const STATUS = {
  pending: ['Waiting for your record', 'pending'],
  verifying: ['Verifying', 'pending'],
  securing: ['Securing your website', 'pending'],
  connected: ['Connected', 'ok'],
  needs_attention: ['Needs attention', 'bad'],
}
// DNS providers we can name from the zone's nameservers, with where to find forwarding for the bare domain.
const PROVIDER_HELP = {
  squarespace: { name: 'Squarespace Domains', forward: 'Domains → your domain → Domain forwarding (or “Forwarding”): forward the bare domain to https://www.<domain>, permanent (301), with “forward path” on if offered.', keep: 'Squarespace shows a locked “Squarespace defaults” group (its own website records) and a “Custom records” group. Our www record must be the ONLY www record: if a Squarespace-default www record is still listed, disconnect the old Squarespace site from this domain (Settings → Domains) so that preset is removed. Do not delete MX, TXT, SPF, DKIM, DMARC or google-site-verification records: they are your email and verifications.' },
  cloudflare: { name: 'Cloudflare', forward: 'DNS: a proxied A record for the bare domain (for example 192.0.2.1) plus a Redirect Rule (or Bulk Redirect) from https://<domain>/* to https://www.<domain>/$1 with “preserve query string”, status 301.', keep: 'Leave MX, TXT (SPF/DKIM/DMARC, verifications) and any other records as they are.' },
  godaddy: { name: 'GoDaddy', forward: 'Domain settings → Forwarding → add forwarding for the bare domain to https://www.<domain>, Permanent (301). GoDaddy adds the A records forwarding needs; keep the www CNAME you added.', keep: 'Do not remove MX, TXT (SPF/DKIM/DMARC) or verification records.' },
  namecheap: { name: 'Namecheap', forward: 'Domain → Redirect Domain: <domain> → https://www.<domain>, Permanent (301). Namecheap creates the URL Redirect record for @; keep the www CNAME.', keep: 'Keep MX, TXT and other records.' },
  wix: { name: 'Wix', forward: 'Domains → Advanced → Domain forwarding (if your plan offers it), or move DNS to a provider that does.', keep: 'Keep MX and TXT records.' },
  google_cloud: { name: 'Google Cloud DNS', forward: 'Cloud DNS has no HTTP forwarding: either keep DNS where it is and use a forwarding service for the bare domain, or move DNS to a provider with forwarding (Cloudflare, GoDaddy, Namecheap, Squarespace Domains all have it).', keep: 'Keep MX, TXT and verification records.' },
}
const providerHelp = (p) => (p && PROVIDER_HELP[p.id]) || { name: p?.name || 'your DNS provider', forward: 'Find “Domain forwarding” / “URL redirect” for the bare domain and forward it to https://www.<domain>, permanent (301), keeping the path if offered. If your provider has no forwarding, you can move DNS to one that does (Cloudflare, GoDaddy, Namecheap, Squarespace Domains).', keep: 'Do not delete MX, TXT (SPF, DKIM, DMARC) or verification records: they are your email and verifications.' }
const ERRORS = {
  invalid_domain: 'That doesn’t look like a domain. Try something like www.yourbusiness.com.',
  reserved_domain: 'That address can’t be used.',
  domain_in_use: 'That domain is already connected to another website on GetShowUps. If it’s yours, contact us.',
  already_has_domain: 'Disconnect your current domain first.',
  rate_limited: 'Too many tries. Please wait a few minutes.',
}

function Copy({ value }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="link-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          window.prompt('Copy this', value)
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Record({ r }) {
  // DNS providers (Squarespace, GoDaddy, Namecheap…) add ".<your domain>" to the Host themselves, so we show only the
  // part before it. Typing the full name there is the most common reason a record is never found.
  return (
    <>
      <dl className="record">
        <div>
          <dt>Type</dt>
          <dd>{r.type}</dd>
        </div>
        <div>
          <dt>Host / Name</dt>
          <dd>
            <code>{r.host}</code> <Copy value={r.host} />
          </dd>
        </div>
        <div>
          <dt>Value / Points to</dt>
          <dd>
            <code>{r.value}</code> <Copy value={r.value} />
          </dd>
        </div>
      </dl>
      {r.host !== r.name && (
        <p className="fine">
          Enter just <code>{r.host}</code> as the Host: your provider adds <code>.{r.zone}</code> itself. Only if it asks for the full name, use <code>{r.name}</code>.
        </p>
      )}
    </>
  )
}

const ago = (ts) => {
  if (!ts) return null
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

// What the last check found, in words the owner can act on.
function Finding({ d }) {
  const r = d.records[0]
  const checked = ago(d.checkedAt)
  const msg = {
    record_doubled: r && (
      <>
        We found your record, but at <code>{r.name}.{r.zone}</code>: your DNS provider added <code>{r.zone}</code> a second time. Edit that record and change its Host to <code>{r.host}</code> (keep the value), then press Check now.
      </>
    ),
    cname_doubled: r && (
      <>
        We found your record, but at <code>{r.name}.{r.zone}</code>: your DNS provider added <code>{r.zone}</code> a second time. Edit that record and change its Host to <code>{r.host}</code>, then press Check now.
      </>
    ),
    wrong_value: r && (
      <>
        We found a verification record for <code>{r.host}</code>, but its value is different. Change the value to <code>{r.value}</code>.
      </>
    ),
    not_verified: <>We still can’t find the record after two weeks. Check the Host and Value above, or disconnect and start again.</>,
    dns_unreachable: <>We couldn’t reach DNS to check just now. We’ll try again automatically.</>,
  }[d.detail]
  if (msg) return <p className={d.detail === 'dns_unreachable' ? 'fine' : 'notice-bad'} role="status">{msg}</p>
  if (d.detail === 'waiting_for_record' || d.detail === 'waiting_for_cname') {
    return (
      <p className="fine" role="status">
        Not found yet{checked ? ` (last checked ${checked})` : ''}. New records usually show up within an hour; we keep checking every 10 minutes.
      </p>
    )
  }
  return checked ? <p className="fine">Last checked {checked}.</p> : null
}

// Where the address points today, in words: which existing record to change (providers allow one www record).
function CurrentPointer({ d }) {
  const c = d.current
  const r = d.records[0]
  if (!c || !r || c.ours) return null
  if (c.platform)
    return (
      <p className="ui-callout ui-callout--info" role="note">
        Right now <strong>{d.hostname}</strong> points to <strong>{c.platform.name}</strong> (<code>{c.target}</code>). In your {c.platform.name} domain’s DNS settings, find the existing{' '}
        <strong>CNAME</strong> record with Host <code>{r.host}</code> and change its value to <code>{r.value}</code>. Don’t add a second <code>{r.host}</code> record. Your email and other records stay
        as they are.
      </p>
    )
  if (c.target)
    return (
      <p className="ui-callout ui-callout--info" role="note">
        Right now <strong>{d.hostname}</strong> points to <code>{c.target}</code>. Edit that existing CNAME record (Host <code>{r.host}</code>) and change its value to <code>{r.value}</code>, rather than
        adding a second one.
      </p>
    )
  return null
}

// Before the switch: the new site must be live (otherwise visitors see "not available"), and old page addresses
// should be imported so links from Google and bookmarks keep working.
function BeforeSwitch({ d, site }) {
  if (!site) return null
  return (
    <ul className="wj-check" aria-label="Before you switch">
      <li className={site.published ? 'is-done' : 'is-todo'}>
        {site.published ? 'Your new website is published.' : <strong>Publish your website first.</strong>}
        {!site.published && <> Until it’s published, {d.hostname} would show “not available” to visitors.</>}
      </li>
      <li className={site.redirects > 0 ? 'is-done' : 'is-todo'}>
        {site.redirects > 0 ? (
          `${site.redirects} old page address${site.redirects === 1 ? '' : 'es'} will forward to your new pages.`
        ) : (
          <>
            <strong>Recommended:</strong> import your current site first (Bring your content, above), so old page addresses from Google and bookmarks forward to your new pages.
          </>
        )}
      </li>
    </ul>
  )
}

function AfterSwitch({ d }) {
  return (
    <div className="after-switch">
      <p className="fine">
        <strong>After you’ve checked {d.hostname} shows your new website:</strong> keep your domain registration (that’s what keeps {d.hostname.replace(/^www\./, '')} yours). Cancel only your old
        website plan, so nothing is lost if you need to switch back.
      </p>
    </div>
  )
}

// The whole setup at a glance, from records we hold plus live public DNS (apex, resolvers): each line is one fact.
const APEX_TEXT = {
  forwards: (a) => `${a.apex} forwards to ${a.canonical}${a.permanent ? ' permanently (301)' : ' (temporary redirect; make it permanent/301 if your provider offers it)'}${a.keepsPath === false ? '; the page path is not kept (visitors land on the home page)' : ''}${a.keepsQuery === false ? '; tracking parameters (?utm_…, gclid) are dropped by this forwarding' : ''}.`,
  forwards_http: (a) => `${a.apex} forwards to ${a.canonical} over plain http only: https://${a.apex} fails because the forwarding service has no certificate for it. Visitors who type https:// see an error.`,
  points_here: (a) => `${a.apex} points at GetShowUps directly, which isn’t supported yet: forward it to ${a.canonical} instead.`,
  other: (a) => `${a.apex} currently shows something else${a.target ? ` (it sends visitors to ${a.target})` : ''}. Forward it to ${a.canonical}.`,
  none: (a) => `${a.apex} has no records: visitors who type it get an error. Forward it to ${a.canonical}.`,
  unreachable: (a) => `We couldn’t check ${a.apex} just now.`,
}
function Checklist({ d, site }) {
  const www = d.status === 'connected'
  const https = www // connected = DNS points at us, hosting reports the certificate active, HTTPS answered
  const apex = d.apex
  const apexOk = apex?.state === 'forwards' && apex.keepsPath !== false
  const items = [
    ['published', site ? Boolean(site.published) : null, site?.published ? 'Website published.' : 'Publish your website first.'],
    ['www', www, www ? `${d.hostname} connected.` : d.detail === 'propagating' ? `${d.hostname}: your DNS change is found at some resolvers and still spreading to others.` : `${d.hostname}: waiting for your DNS change.`],
    ['https', https, https ? 'Secure connection (https) active.' : 'Secure connection: set up once the record is found.'],
    ...(apex ? [['apex', apexOk ? true : apex.state === 'unreachable' ? null : false, APEX_TEXT[apex.state]?.(apex) || ''], ['redirect', apexOk ? (apex.keepsQuery === false ? null : true) : false, apexOk ? (apex.keepsQuery === false ? 'Redirect works, but drops tracking parameters.' : 'Redirect verified: path and parameters kept.') : 'Redirect from the bare domain: not verified yet.']] : []),
    ['live', www && https && (!apex || apexOk), www && https && (!apex || apexOk) ? 'Website fully live.' : 'Website fully live: after the steps above.'],
  ]
  return (
    <ul className="wj-check" aria-label="Domain setup" data-domain-checklist>
      {items.map(([id, ok, text]) => (
        <li key={id} className={ok === true ? 'is-done' : ok === null ? 'is-info' : 'is-todo'} data-check={id} data-ok={ok === true ? 'yes' : ok === null ? 'unknown' : 'no'}>
          {text}
        </li>
      ))}
    </ul>
  )
}
// What each public resolver answers for www: a split means the change is still spreading or two records exist.
function Resolvers({ d }) {
  const r = d.resolvers
  if (!r || (r.cloudflare !== false && r.google !== false)) return null
  const old = r.cloudflare === false ? r.cloudflareSees : r.googleSees
  return (
    <p className="notice-soft" role="status" data-resolvers>
      Two public resolvers disagree about <code>{d.hostname}</code>: one already answers our address, the other still answers {old ? <code>{old}</code> : 'the old record'}. Visitors using that resolver still see the old website until it
      updates (up to a few hours after a correct change). If this lasts longer than a day, your DNS has two www records: keep only the one pointing to <code>{d.records?.[0]?.value || 'getshowups.pages.dev'}</code>.
    </p>
  )
}
function Steps({ d, site }) {
  if (d.status === 'connected') {
    return (
      <>
        <p>
          Your website is live at{' '}
          <a href={d.url} target="_blank" rel="noreferrer">
            {d.hostname}
          </a>{' '}
          with a secure (https) connection.
        </p>
        <Checklist d={d} site={site} />
        <Resolvers d={d} />
        <BareDomain d={d} />
        <AfterSwitch d={d} />
      </>
    )
  }
  if (d.step === 'verify') {
    return (
      <>
        <p>
          <strong>Step 1 of 2: verify you own {d.hostname}.</strong> Sign in where you bought your domain (for example GoDaddy, Namecheap or Squarespace), open its DNS settings and add this record. It doesn’t change your current website or email.
        </p>
        {d.records.map((r) => (
          <Record key={r.type} r={r} />
        ))}
        <Finding d={d} />
      </>
    )
  }
  if (d.step === 'activate') {
    return d.detail === 'activation_pending' ? (
      <p>
        <strong>Ownership verified.</strong> Our team has been alerted to finish setting up hosting for {d.hostname}; the last step will appear here when it’s ready. There’s nothing for you to do right now.
      </p>
    ) : (
      <p>
        <strong>Ownership verified.</strong> We’re preparing hosting for {d.hostname}{d.detail === 'provider_error' ? ' (a step on our side failed and is being retried automatically)' : ''}. We’ll show the last step here as soon as it’s ready.
      </p>
    )
  }
  return (
    <>
      <p>
        <strong>Step 2 of 2: point {d.hostname} to your new website.</strong> Once this record is in place, {d.hostname} shows your GetShowUps website instead of anything that was there before.
      </p>
      <BeforeSwitch d={d} site={site} />
      <CurrentPointer d={d} />
      {d.records.map((r) => (
        <Record key={r.type} r={r} />
      ))}
      {d.status === 'securing' && d.detail === 'certificate_pending' ? <p className="fine">Record found. We’re setting up a secure connection (https). This can take up to an hour.</p> : d.detail === 'propagating' ? <p className="fine" data-propagating>Record found at one public resolver; others are still catching up (usually within an hour, up to the old record’s lifetime). We keep checking every 10 minutes.</p> : <Finding d={d} />}
      {d.detail === 'dns_changed' && <p className="notice-soft">The record for {d.hostname} no longer points to your website. Add it back to reconnect.</p>}
      <Resolvers d={d} />
      <Checklist d={d} site={site} />
      <BareDomain d={d} />
    </>
  )
}

// www.example.com is connected; example.com (without www) is separate and stays where it is unless the owner forwards it.
function BareDomain({ d }) {
  if (!d.hostname.startsWith('www.')) return null
  const apex = d.hostname.slice(4)
  const a = d.apex
  const help = providerHelp(d.provider)
  const done = a?.state === 'forwards' && a.keepsPath !== false
  return (
    <details className="domain-apex" open={!done} data-apex-state={a?.state || 'unknown'}>
      <summary>
        <strong>{apex}</strong> (without www): {done ? 'forwards to your website' : 'make it reach your website too'}
      </summary>
      <p className="fine">
        Your website’s one address is <code>https://{d.hostname}</code>. Visitors who type <code>{apex}</code> should be forwarded there (a permanent redirect that keeps the page path), so search engines see a single website. Only the www
        address is connected to GetShowUps; the bare domain stays where your DNS provider has it.
      </p>
      {a && APEX_TEXT[a.state] && (
        <p className={done ? 'fine' : 'notice-soft'} role="status" data-apex-finding>
          {APEX_TEXT[a.state](a)}
        </p>
      )}
      <ol className="fine domain-steps">
        <li>
          <strong>Where:</strong> {d.provider?.name ? `your DNS is at ${d.provider.name}` : 'sign in where your DNS is managed'} (the same place you added the www record).
        </li>
        <li>
          <strong>Forwarding:</strong> {help.forward.replaceAll('<domain>', apex)}
        </li>
        <li>
          <strong>Keep:</strong> {help.keep}
        </li>
        <li>
          <strong>Check:</strong> open <code>https://{apex}/privacy</code> and <code>http://{apex}/?test=1</code>: both should land on <code>https://{d.hostname}/…</code>. Then press Check now here.
        </li>
        <li>
          <strong>If your provider has no forwarding</strong> (some registrars and Google Cloud DNS): keep DNS where it is and use a forwarding service for the bare domain, or move DNS to a provider with forwarding. Nothing about the www
          record or your email changes.
        </li>
      </ol>
    </details>
  )
}

const NEEDS_FIX = ['record_doubled', 'cname_doubled', 'wrong_value', 'not_verified']

export default function DomainSettings({ siteUrl, compact = false, onChange, site = null }) {
  const [data, setData] = useState(null)
  const [mode, setMode] = useState(null)
  const [state, setState] = useState({})
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    api('/api/dashboard/domain').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  }, [])
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your domain settings.</p>

  const act = async (body) => {
    setState({ busy: true })
    const { status, data: d } = await api('/api/dashboard/domain', { method: 'POST', body })
    if (status === 200) {
      setData(d)
      setState({})
      setMode(null)
      setConfirming(false)
      onChange?.(d)
    } else setState({ error: ERRORS[d.error] || 'Something went wrong. Please try again.', suggestion: d.suggestion })
  }
  const d = data.domain
  // "Securing" only once the record is found; before that we're waiting on the owner's DNS change, and say so.
  const [label, tone] = d
    ? NEEDS_FIX.includes(d.detail)
      ? ['Record needs a fix', 'bad']
      : d.detail === 'waiting_for_cname'
        ? ['Waiting for your DNS change', 'pending']
        : d.detail === 'propagating'
          ? ['DNS change found, spreading', 'pending']
          : d.detail === 'dns_inconsistent'
            ? ['Connected · one resolver still old', 'warn']
            : STATUS[d.status] || ['Checking', 'pending']
    : []

  if (d) {
    return (
      <div className="form">
        <p className="domain-status">
          <strong>{d.hostname}</strong> <Pill tone={tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : d.detail === 'certificate_pending' || d.step === 'activate' ? 'info' : 'warn'}>{label}</Pill>
        </p>
        <Steps d={d} site={site} />
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="card-actions">
          <button type="button" className={d.status === 'connected' ? 'btn btn-quiet' : 'btn btn-primary'} disabled={state.busy} onClick={() => act({ action: 'check' })} data-domain-check>
            {state.busy ? 'Checking…' : 'Check now'}
          </button>
          {!confirming ? (
            <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
              Disconnect domain
            </button>
          ) : (
            <div className="confirm">
              <p className="fine">Your website stays live at {siteUrl.replace(/^https?:\/\//, '')}. {d.hostname} stays yours; remove the record at your domain provider when you’re ready.</p>
              <button type="button" className="btn btn-danger btn-sm" disabled={state.busy} onClick={() => act({ action: 'disconnect' })}>
                Disconnect {d.hostname}
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="form">
      <div className="choice-list" role="radiogroup" aria-label="Website address">
        {[
          ['getshowups', 'Use your GetShowUps address', siteUrl.replace(/^https?:\/\//, '')],
          ['own', 'Use your own domain', 'You already own a domain, like yourbusiness.com'],
          ['buy', 'Get a new domain', 'Buy one in your name, then connect it'],
        ].map(([value, title, sub]) => (
          <label key={value} className="choice-card">
            <input type="radio" name="address" value={value} checked={(mode || 'getshowups') === value} onChange={() => setMode(value)} />
            <span>
              <strong>{title}</strong>
              <span className="fine">{sub}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'own' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            act({ action: 'connect', hostname: new FormData(e.currentTarget).get('hostname') })
          }}
        >
          <label className="field">
            <span>Enter your domain</span>
            <input name="hostname" placeholder="www.yourbusiness.com" autoCapitalize="none" autoCorrect="off" spellCheck="false" required inputMode="url" />
          </label>
          {state.error && (
            <p className="form-error" role="alert">
              {state.error}
              {state.suggestion && (
                <>
                  {' '}
                  Use <button type="button" className="link-btn" onClick={() => act({ action: 'connect', hostname: state.suggestion })}>{state.suggestion}</button> instead, and set your domain provider to forward the bare domain to it.
                </>
              )}
            </p>
          )}
          <button className="btn btn-primary" disabled={state.busy}>
            {state.busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
      {mode === 'buy' && (
        <div className="stack">
          <p>Buy your domain from any domain company (for example Namecheap, GoDaddy or Squarespace) in your own name, so it always belongs to you. Then choose “Use your own domain” and enter it here.</p>
          <p className="fine">Tip: choose www.yourname.com. It connects most easily.</p>
        </div>
      )}
      {!compact && <p className="fine">Your domain always stays yours. If you ever leave GetShowUps, you can point it anywhere else.</p>}
    </div>
  )
}
