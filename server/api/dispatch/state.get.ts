import { dispatchAudit, dispatchPermits, dispatchRevision } from '~/server/utils/dispatchStore'

export default defineEventHandler(() => ({
  permits: dispatchPermits.value,
  audit: dispatchAudit.value,
  revision: dispatchRevision.value,
}))
