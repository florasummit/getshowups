import { api } from './api.js'

// Creates a single-use invite and submits it straight to the existing confirmation step, which
// redirects to Google. The form POST carries our Origin, satisfying the start endpoint's check.
export async function connectCalendar() {
  const { status, data } = await api('/api/dashboard/connect-link', { method: 'POST' })
  if (status !== 201 || !data.invite) return false
  const form = document.createElement('form')
  form.method = 'post'
  form.action = '/api/google/oauth/start'
  for (const [k, v] of Object.entries({ invite: data.invite, confirm: 'yes' })) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = k
    input.value = v
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
  return true
}
