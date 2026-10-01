import type { Metadata } from 'next'
import { ResetForm } from './reset-form'

/**
 * Where the emailed link lands. Outside the app shell, like /login: whoever
 * opens it is not signed in, and may never have been on this device.
 *
 * The token is not checked here. Whether it is unknown, used or expired is
 * answered only when a password is submitted, in one generic message, so the
 * page itself says nothing about a link anyone can guess at.
 *
 * No referrer: the token is in this URL, and "Sign in" is a link off it.
 */
export const metadata: Metadata = {
  title: 'Choose a new password',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

const ResetPage = async ({ params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  return <ResetForm token={token} />
}

export default ResetPage
