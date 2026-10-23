# Remote access (Tailscale)

The dashboard has no login and starts agents with full access to this machine, so it listens on `127.0.0.1` only and its request guard (`server/src/app.ts`) refuses any `Host` or `Origin` that is not loopback. To use it from a phone or another PC, keep both of those and put [Tailscale](https://tailscale.com) in front: only devices signed in to your tailnet can reach it, over HTTPS, and nothing is exposed to the internet.

## Setup

1. Install Tailscale on the dashboard PC and on each device that should reach it, signed in to the same account.
2. In the admin console, **DNS** page: enable **MagicDNS** and **HTTPS Certificates**.
3. On the dashboard PC, serve the dashboard to the tailnet (it keeps running in the background and survives reboots):

   ```powershell
   tailscale serve --bg 5190
   tailscale serve status
   ```

   `status` prints the address, e.g. `https://mypc.tail1234.ts.net`.

4. Tell the dashboard to trust that one name, then start it. Comma-separate several names; matching is exact, no wildcards.

   ```powershell
   $env:AGENT_DASHBOARD_TRUSTED_HOSTS = "mypc.tail1234.ts.net"
   pnpm start
   ```

   To keep it for every new terminal: `setx AGENT_DASHBOARD_TRUSTED_HOSTS "mypc.tail1234.ts.net"` (then open a new terminal).

5. Open `https://mypc.tail1234.ts.net` on the phone with Tailscale connected.

## Notes

- Never use `tailscale funnel` for the dashboard: it publishes the address to the whole internet.
- Anyone in your tailnet can drive the dashboard. If you share the tailnet, restrict access to the dashboard PC with Tailscale access controls.
- To stop: `tailscale serve reset`, and unset the variable (`setx AGENT_DASHBOARD_TRUSTED_HOSTS ""` or remove it from the user environment variables).
- The server still binds `127.0.0.1`; Tailscale Serve proxies to it locally. Without the variable the guard behaves exactly as before.
