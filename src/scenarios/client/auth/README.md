Several things to test:

1. PRM discovery (www-authenticate, path, root)
   1. Also status codes received: dictate expected behavior on non-200, non-404 status codes (e.g. continue probing, or stop).
2. Oauth AS metadata discovery (path, no-path) priority checking
3. Auth flows (DCR, pre-register, CIMD)
   1. Pre-register needs a way to pass in the pre-registered creds
   2. CIMD needs a way to pass in pre-registered
4. Scope selection
5. WWW-authenticate on tool call (i.e. init / listTools w/o auth)

Negative tests:

- rejecting invalid resource parameters
-

Server scenarios need:

1. A "regular" server, that just responds to initialize
2. Hosting metadata endpoints at configurable locations w/ proper fields
3. Ability to return 2 URLs? although I guess not b/c the checks can be shared, and we just need 1 URL. does need to manage 2 server listeners though.
4. Fake auth server
   1. Should be swappable, want to make

Client examples need:

1. Easy "redirect follower" oauth provider (i.e. skip browser usage)
