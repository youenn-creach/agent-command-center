# Private web search (SearXNG)

Ctrl+K questions that need the internet ("who won the final?", "opening hours of the Picasso museum?") go through **your own [SearXNG](https://github.com/searxng/searxng)** on this computer. SearXNG is a metasearch engine: it sends the query to public search engines without an account or cookies, so no search profile is built. It uses about 90 MB of RAM and almost no CPU; reading the pages with the local model is what takes the time.

The app only talks to SearXNG on a loopback address (`http://127.0.0.1:8888`, or `ACC_SEARXNG_URL`). Web search is **off** until you give the Knowledge agent **Read** on **Web search** in Connections & Permissions.

## Install (no Docker, no sudo)

Needs `git` and [uv](https://docs.astral.sh/uv/) (or Python 3.11+ with `venv`). About 200 MB.

```bash
mkdir -p ~/.local/share/acc-searxng && cd ~/.local/share/acc-searxng
git clone --depth 1 https://github.com/searxng/searxng src
uv venv --python python3 venv
VIRTUAL_ENV=$PWD/venv uv pip install -r src/requirements.txt -r src/requirements-server.txt setuptools wheel
VIRTUAL_ENV=$PWD/venv uv pip install --no-build-isolation -e src
```

`~/.local/share/acc-searxng/settings.yml` (replace the secret with the output of `openssl rand -hex 32`, and keep the file private: `chmod 600`):

```yaml
use_default_settings:
  engines:
    keep_only: [duckduckgo, yahoo, yep, privacywall, zapmeta, wikipedia]
general:
  instance_name: "ACC search"
  enable_metrics: false
search:
  safe_search: 0
  default_lang: "en"
  formats: [html, json]
server:
  bind_address: "127.0.0.1"
  port: 8888
  secret_key: "REPLACE-WITH-A-RANDOM-SECRET"
  limiter: false
  public_instance: false
  image_proxy: false
outgoing:
  request_timeout: 5.0
engines:
  - {name: duckduckgo, disabled: false}
  - {name: yahoo, disabled: false}
  - {name: yep, disabled: false}
  - {name: privacywall, disabled: false}
  - {name: zapmeta, disabled: false}
  - {name: wikipedia, disabled: false}
```

`~/.config/systemd/user/acc-searxng.service`:

```ini
[Unit]
Description=SearXNG for Agent Command Center (private web search, local only: 127.0.0.1:8888)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/acc-searxng/src
Environment=SEARXNG_SETTINGS_PATH=%h/.local/share/acc-searxng/settings.yml
ExecStart=%h/.local/share/acc-searxng/venv/bin/python -m searx.webapp
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now acc-searxng
curl -s "http://127.0.0.1:8888/search?q=open-meteo&format=json" | head -c 300
```

## Choosing engines

Search engines increasingly block automated queries, and which ones answer depends on your connection. In October 2026, from a home connection in Europe, Google, Brave and Qwant refused and Startpage and Mojeek required a proof-of-work CAPTCHA; DuckDuckGo, Yahoo, Yep, PrivacyWall and ZapMeta answered well. To test one engine: `curl "http://127.0.0.1:8888/search?format=json&engines=yahoo&q=python+release+notes"`. SearXNG suspends an engine for a while after it blocks, so a blocked engine costs little.

## Update

```bash
cd ~/.local/share/acc-searxng && git -C src pull --ff-only && VIRTUAL_ENV=$PWD/venv uv pip install -r src/requirements.txt -r src/requirements-server.txt && systemctl --user restart acc-searxng
```
