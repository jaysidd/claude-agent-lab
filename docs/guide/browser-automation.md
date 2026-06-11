# Browser Automation

`[Live]`

## What this is

Browser automation lets an agent drive a real web browser. It can open a page,
click around, fill forms, and read what is on screen, then bring the result
back into your conversation. Under the hood this is the official
[Playwright MCP server](https://github.com/microsoft/playwright-mcp), wired in
per agent through the same plumbing as any other [MCP server](tools-and-mcp.md).

Because a web page is content from the outside world, a browsing agent is the
single most powerful and most sensitive thing you can turn on. So it is gated.
An agent can only visit the domains you explicitly allow, and a hard floor
always blocks your own machine and local network, even from the agent's view.

## How to use it

1. Open the **🌐 Browser** panel from the toolbar above the message box, or with
   the ⌘K palette.
2. Pick an agent and check **enabled for this agent**.
3. Add the domains the agent is allowed to visit, one at a time. Type a bare
   domain like `github.com` and click **Allow domain**. Subdomains are included
   automatically, so `github.com` also covers `api.github.com`.
4. Leave **headless** on to run the browser invisibly, or turn it off to watch
   it work.

That is it. Now ask the agent to do something on one of those sites, for
example: "Go to example.com and tell me the main heading." The agent will open
the browser, navigate, read the page, and report back. If it tries to visit a
site you have not allowed, the navigation is blocked and the agent is told why.

An agent with no allowed domains has the browser tools but nowhere to go, so it
cannot navigate until you add at least one domain.

## How it works

When browser automation is on for an agent, two things happen on every
`query()` call for that agent:

- The Playwright MCP server is added to the agent's `mcpServers`, so its
  `browser_navigate`, `browser_click`, `browser_type`, and other tools light
  up. It runs `--isolated` (a fresh, in-memory browser profile with no access
  to your real Chrome cookies) and `--headless` by default.
- A `PreToolUse` hook is attached to `browser_navigate`. Before any navigation
  runs, the hook checks the URL against a hard deny-list (localhost, private
  network ranges like `192.168.x` and `10.x`, link-local and cloud-metadata
  addresses, and any non-web protocol such as `file://`) and then against your
  allow-list. The deny-list is a floor that cannot be allow-listed away, and it
  understands obfuscated addresses (a decimal or hex spelling of `127.0.0.1`,
  or an IPv4-mapped IPv6 address, is still blocked).

## Common questions

**Why can't I let the agent browse anywhere?**
A browser that can follow any link is a way to reach your home network and
local services, and a malicious page can try to talk an agent into doing
exactly that. Allow-listing the domains you trust keeps the agent useful while
keeping that door shut. It also mirrors how you would brief a real assistant:
here are the sites you may use.

**Does the agent see my logged-in sessions or cookies?**
No. The browser runs in an isolated, in-memory profile. It starts with no
cookies and forgets everything when the run ends. It cannot read your real
browser's saved logins.

**Can a page I allow-listed redirect the agent somewhere bad?**
This is the one honest limitation. The per-navigation gate fires on explicit
navigation, and Playwright's own origin controls do not re-check link-clicks or
redirects inside a page. So if you allow-list a site, you are trusting that
site not to bounce the agent to a private address. The practical guidance:
allow-list only domains you actually trust. A fully airtight version would route
the browser through a connect-time filtering proxy, which is noted as a future
enhancement.

**Do I need to install anything?**
The first time an agent uses the browser, the Playwright MCP server is fetched
through `npx`, which may take a moment. After that it is cached.

**Is the browser shared between agents?**
No. Each agent has its own browser configuration and its own allow-list. Turning
it on for Ops does not turn it on for Comms.

## Where to go next

- [Tools and MCP Servers](tools-and-mcp.md) for the general MCP mechanism this is built on.
- [Approval Gates](approval-gates.md) for pausing other dangerous tools, like Bash and Write, for your sign-off.
- [Agents](agents-and-overview.md) to set up a dedicated research agent to give the browser to.
