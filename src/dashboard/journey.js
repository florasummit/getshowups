// The website journey's steps, derived only from real state: the draft, the latest import, the published version and
// the domain record. Pure (no browser APIs), so it is unit-tested (test/journey.test.js).
// action: [label, target] where target is a section id on the Website tab ('site-import' …), 'publish', or a URL.
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const bare = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '')

// canPublish: the same conditions the status card uses (no unkept AI revision, nothing unsaved, publishing not paused).
export function journeySteps({ website: w, domain: d, studio }, imp, { canPublish = true } = {}) {
  const hasDraft = !w.generated
  const redirects = w.draft?.redirects?.length || 0
  const imported = imp && imp.status === 'done' && imp.appliedAt ? imp : null
  const connected = d?.status === 'connected'
  return [
    {
      id: 'content',
      title: 'Bring your content',
      done: hasDraft,
      pill: hasDraft ? ['ok', imported ? 'Imported' : 'Ready'] : ['neutral', 'Not started'],
      detail: imported
        ? `Imported from ${bare(imported.sourceUrl)} on ${day(imported.appliedAt)}${redirects ? ` · ${redirects} old address${redirects === 1 ? '' : 'es'} kept` : ''}.`
        : hasDraft
          ? studio
            ? 'Your content is ready. Moving from another website? Import it so old page addresses keep working.'
            : 'Your content is ready.'
          : studio
            ? 'Import the pages of your current website, or let us write one from your business details.'
            : 'Let us write your website from your business details.',
      action: studio ? [imported ? 'Import again' : 'Import my current website', 'site-import'] : hasDraft ? null : ['Create my website', 'site-create'],
      // Moving a domain without old addresses → links from Google and bookmarks would break.
      recommend: Boolean(hasDraft && studio && !imported && !redirects && d && !connected),
    },
    {
      id: 'edit',
      title: 'Review, edit and preview',
      done: hasDraft && Boolean(w.published),
      pill: hasDraft ? ['info', 'Draft ready'] : ['neutral', 'After content'],
      detail: hasDraft ? 'Check every page on phone and desktop. Changes save as you go and stay private until you publish.' : 'Available once you have content.',
      action: hasDraft ? ['Edit my website', 'site-edit'] : null,
      preview: hasDraft,
    },
    {
      id: 'publish',
      title: 'Publish',
      done: Boolean(w.published && !w.changed),
      pill: w.published ? (w.changed ? ['warn', 'Changes not published'] : ['ok', 'Live']) : ['neutral', 'Not published'],
      detail: w.published
        ? w.changed
          ? 'Your edits are saved but visitors still see the previous version.'
          : 'Visitors see your new website at your GetShowUps address.'
        : 'Your website goes live at your GetShowUps address first, so you can check it before moving your domain.',
      action: canPublish && hasDraft && (!w.published || w.changed) ? [w.published ? 'Publish changes' : 'Publish website', 'publish'] : null,
    },
    {
      id: 'domain',
      title: 'Connect your domain',
      done: connected,
      pill: !d
        ? ['neutral', 'Optional']
        : connected
          ? ['ok', 'Connected']
          : d.step === 'verify'
            ? ['warn', 'Add the verification record']
            : d.step === 'activate'
              ? ['info', 'Preparing hosting']
              : d.detail === 'certificate_pending'
                ? ['info', 'Securing (https)']
                : d.status === 'needs_attention' || ['cname_doubled', 'dns_changed'].includes(d.detail)
                  ? ['bad', 'Needs attention']
                  : ['warn', 'Needs your DNS change'],
      detail: !d
        ? 'Use your own address (like www.yourbusiness.com). Your domain stays yours.'
        : connected
          ? `${d.hostname} now shows your new website.`
          : d.step === 'verify'
            ? `Prove you own ${d.hostname} with one DNS record. Your current website keeps working.`
            : d.step === 'activate'
              ? `Ownership of ${d.hostname} is verified. We’re preparing hosting.`
              : `Change one DNS record so ${d.hostname} shows your new website.`,
      action: ['Open domain settings', 'site-domain'],
    },
    {
      id: 'verify',
      title: 'Check it’s live',
      done: connected,
      pill: connected ? ['ok', 'Verified'] : ['neutral', 'After the switch'],
      detail: connected
        ? 'Secure connection (https) confirmed and your address serves your new website.'
        : 'We check your address and its secure connection automatically once the record is in place.',
      action: connected ? ['Open my website', d.url] : null,
    },
  ]
}
