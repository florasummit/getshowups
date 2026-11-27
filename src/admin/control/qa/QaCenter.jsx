// Control Center → QA: the QA Command Center. One tab that absorbs the earlier "Testing" view (its guided sessions,
// activation measurement and earlier CI runs stay reachable under Manual and Runs; the old ?view=qa&journey=… and
// ?for=… links land on Manual, ?session=/?run= still open the guided session / run review).
// Sub-views are URL state (?view=qa&tab=tests|runs|manual|defects|backlog, ?test=, ?exec=, ?item=), so reload, Back
// and shared links land in the same place. Every run starts from the plan dialog; nothing runs on page load.
import { Link } from '../ui.jsx'
import { IdeaNote } from './parts.jsx'
import { QaOverview } from './Overview.jsx'
import { TestDetail, TestsView } from './Tests.jsx'
import { ExecutionDetail, RunsView } from './Runs.jsx'
import { ManualView } from './Manual.jsx'
import { ItemDetail, ItemsView } from './Items.jsx'
import { QA_TABS, qaTabOf } from '../qa-lib.js'

export default function QaCenter({ o, params, go }) {
  const tab = qaTabOf(params)
  let body
  if (params.test) body = <TestDetail key={params.test} id={params.test} go={go} />
  else if (params.exec) body = <ExecutionDetail key={params.exec} id={params.exec} go={go} />
  else if (params.item) body = <ItemDetail key={params.item} id={params.item} go={go} />
  else if (tab === 'tests') body = <TestsView params={params} go={go} />
  else if (tab === 'runs') body = <RunsView params={params} go={go} />
  else if (tab === 'manual') body = <ManualView o={o} params={params} go={go} />
  else if (tab === 'defects' || tab === 'backlog') body = <ItemsView key={tab} list={tab} params={params} go={go} />
  else body = <QaOverview go={go} />
  return (
    <div className="cc-main qa-center" data-qa-center data-qa-tab={tab}>
      <div className="qa-bar-top">
        <nav className="qa-subnav" aria-label="QA">
          {QA_TABS.map(([id, label]) => (
            <Link key={id} to={id === 'overview' ? { view: 'qa' } : { view: 'qa', tab: id }} go={go} aria-current={tab === id ? 'page' : undefined} data-qa-subnav={id}>
              {label}
            </Link>
          ))}
        </nav>
        <IdeaNote params={params} />
      </div>
      {body}
    </div>
  )
}
