# The browser-test site is off

The staging edge mounts this directory when `STAGING_WEB_DIR` is not set: it holds no `enabled/*.caddy`, so the edge
serves the API alone. `deploy/staging/web-test.sh` and docs/99 §14 turn the site on.
