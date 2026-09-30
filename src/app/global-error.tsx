'use client'

/**
 * The last resort: this replaces the root layout, so it cannot use any of the
 * app's providers or tokens and has to carry its own <html>. Styles are inline
 * for the same reason.
 */
const GlobalError = ({ error }: { error: Error & { digest?: string } }) => (
  <html lang="en">
    <body
      style={{
        margin: 0,
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#f6f2ea',
        color: '#221c20',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        textAlign: 'center',
        padding: '24px',
      }}
    >
      <div>
        <h1 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>Croft failed to start.</h1>
        <p style={{ fontSize: 13, color: '#5c5358', marginTop: 8 }}>
          Reload the page. If it persists, the server logs will have the detail.
        </p>
        {error.digest && (
          <code style={{ fontSize: 11, color: '#5c5358' }}>digest {error.digest}</code>
        )}
      </div>
    </body>
  </html>
)

export default GlobalError
