// Resizes a picked image in the browser before upload (fast pages, small storage). Logos keep PNG
// transparency; photos become JPEG. Returns a Blob ≤ ~1 MB, or null if the file isn't an image.
export async function prepareImage(file, { kind = 'photo', max: maxSide } = {}) {
  if (!file || !/^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.type)) return null
  const max = maxSide || (kind === 'logo' ? 600 : 1600)
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const type = kind === 'logo' && file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  for (const quality of [0.86, 0.75, 0.6]) {
    const blob = await new Promise((r) => canvas.toBlob(r, type, quality))
    if (blob && blob.size <= 1_000_000) return blob
  }
  return null
}

export async function uploadImage(file, kind) {
  const blob = await prepareImage(file, { kind })
  if (!blob) return { error: 'That file isn’t a photo we can use. Try a JPG or PNG.' }
  try {
    const res = await fetch('/api/dashboard/website/assets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob })
    const data = await res.json().catch(() => ({}))
    if (res.status === 201) return { asset: data.asset }
    return { error: data.error === 'too_many' ? 'You’ve reached the photo limit (60). Remove one first.' : data.error === 'quota' ? 'You’ve used your 50 MB of photo storage. Remove photos you no longer use first.' : 'Upload failed. Please try again.' }
  } catch {
    return { error: 'Upload failed. Please try again.' }
  }
}

async function send(blob) {
  const res = await fetch('/api/dashboard/website/assets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob })
  const data = await res.json().catch(() => ({}))
  if (res.status === 201) return { asset: data.asset }
  return { error: data.error === 'too_many' ? 'You’ve reached the photo limit. Remove photos you no longer use first.' : data.error === 'quota' ? 'You’ve used your 50 MB of photo storage. Remove photos you no longer use first.' : 'Upload failed. Please try again.' }
}

// A photo plus its phone-sized copy (≤800 px), so phones download a fraction of the bytes. Returns { asset, small }.
export async function uploadPhotoWithCopy(file) {
  const r = await uploadImage(file, 'photo')
  if (!r.asset) return r
  const small = await prepareImage(file, { max: 800 })
  const s = small ? await send(small).catch(() => ({})) : {}
  return { asset: r.asset, small: s.asset || null }
}

// A phone-sized copy of a photo already uploaded (read back from our own store). Returns { small } or { error }.
export async function makePhoneCopy(assetId) {
  try {
    const blob = await (await fetch(`/site-assets/${assetId}`, { credentials: 'same-origin' })).blob()
    const small = await prepareImage(new File([blob], 'photo', { type: blob.type }), { max: 800 })
    if (!small) return { error: 'unsupported' }
    const s = await send(small)
    return s.asset ? { small: s.asset } : s
  } catch {
    return { error: 'failed' }
  }
}
