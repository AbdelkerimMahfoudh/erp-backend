# The private test sites are off

The production edge mounts this directory when `WEB_DIR` is not set: it holds no `enabled/*.caddy`, so the edge serves
the API alone. `deploy/production/test-sites.sh` and docs/100 §16 (D217) turn the sites on.
