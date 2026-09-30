import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Standalone output keeps the runtime image small; see Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // AGENTS.md is hand-written, read by every agent at session start, and held
  // under 8KB by CI. `next dev` appends a 679-byte block to it on every start,
  // so the file arrives over budget and the failure lands on whichever PR is
  // unlucky enough to be next — for a reason that appears nowhere in its diff.
  agentRules: false,
  // Loaded only when attachments live in S3. The SDK's credential chain
  // requires optional providers at runtime, which bundling breaks; kept
  // external, it is copied into the standalone node_modules as it is.
  // pg and bcryptjs: scripts/start.mjs runs migrations and the first
  // administrator outside the bundle, so they must exist as packages in the
  // standalone node_modules rather than only inside bundled server chunks.
  serverExternalPackages: ['@aws-sdk/client-s3', 'pg', 'bcryptjs'],
  // Set by the app rather than left to a proxy: Traefik added these on the
  // compose deployment, and a platform that terminates TLS itself (App
  // Runner) adds none, so the same image was served without them there.
  // Behind Traefik they are simply set twice, to the same values.
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
    // Attachments are previewed in Croft's own frames (HTML sandboxed, PDF
    // inline), which DENY would block. Last match wins for a repeated key.
    // Safe to frame: the route serves HTML and SVG under `CSP: sandbox`.
    {
      source: '/api/files',
      headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
    },
  ],
}

export default nextConfig
