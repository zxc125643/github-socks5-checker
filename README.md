# GitHub SOCKS5 daily checker + edgetunnel

This repository template:

1. Fetches public SOCKS5 lists every day in GitHub Actions and, on this Mac, through `launchd`.
2. Checks candidates through `https://check.socks5.cmliussss.net/check`.
3. Re-tests surviving nodes locally with real HTTPS requests through each SOCKS5 proxy.
4. Scores exit-IP purity with a 5-point model adapted from `yxip_git_action`.
5. Ranks locally usable nodes by purity, risk score, local latency, and checker latency.
6. Publishes `data/socks5.json`, `data/socks5.txt`, `data/results.json`, and `data/status.json`.
7. Lets the edgetunnel admin page use the generated JSON in its existing "获取更多 SOCKS5" dialog.

## Create the GitHub repository

Create a repository and upload all files in this folder. GitHub Actions must have permission to write:

`Settings` -> `Actions` -> `General` -> `Workflow permissions` -> `Read and write permissions`.

Run `Update SOCKS5 list` once from the Actions tab. After it succeeds, the list URL is:

```text
https://raw.githubusercontent.com/zxc125643/github-socks5-checker/main/data/socks5.json
```

For a private repository, raw GitHub URLs require authentication and cannot be read by the Cloudflare admin page. Use a public repository for the generated list, or publish the JSON through a separate authenticated endpoint.

## Connect edgetunnel

The `edgetunnel/_worker.js` file is based on `cmliu/edgetunnel` main as downloaded on 2026-06-08. Deploy it in place of the current Worker file, keep your existing variables and KV binding, and add:

```text
SOCKS5_LIST_URL=https://raw.githubusercontent.com/zxc125643/github-socks5-checker/main/data/socks5.json
```

After deployment, log in to `/admin`, choose SOCKS5 reverse proxy, then click the existing "获取更多 SOCKS5" button. If `SOCKS5_LIST_URL` is absent or invalid, the upstream default list remains in use.

Do not put the admin password, GitHub token, or Cloudflare API token in this repository. Configure secrets only in GitHub Actions or Cloudflare settings.

## Selection policy

The script first asks the checker service for exit-IP metadata, then confirms true usability from the machine running the job by sending HTTPS requests through the SOCKS5 proxy. By default a node must pass both local targets:

```text
https://www.gstatic.com/generate_204
https://www.cloudflare.com/cdn-cgi/trace
```

Purity is scored from 0 to 5. Bogon, Tor, proxy, VPN, abuser flags, and high company/ASN abuse labels reduce the score. `data/results.json` keeps every locally usable node with `purityStatus`, `purityScore`, `purityPercent`, `purityReasons`, and the per-target local test result.

`data/socks5.json` and `data/socks5.txt` publish clean preferred nodes first. If no clean nodes survive, the default is to publish locally usable fallback nodes with their dirty/warning purity labels instead of pretending they are clean. Set `PUBLISH_ONLY_CLEAN=true` to publish only clean nodes; set `RETAIN_PREVIOUS_ON_EMPTY=true` only if you intentionally want to keep the previous list when a run finds no publishable nodes.

`data/status.json` records how many candidates failed at the checker step, how many failed local validation, and a summary of purity statuses.

Public free proxies are untrusted. Never send credentials, private traffic, payment data, or other sensitive information through them.

## macOS scheduled updater

This Mac uses `scripts/macos_update_socks5.sh` plus a `launchd` plist generated from `launchd/com.zxc125643.github-socks5-checker.plist.template`. The local config lives in `scripts/macos_update_socks5.env` and is intentionally ignored by Git.

Useful commands:

```bash
scripts/macos_update_socks5.sh
tail -f logs/macos_update_socks5.out.log
tail -f logs/macos_update_socks5.err.log
launchctl print gui/$(id -u)/com.zxc125643.github-socks5-checker
```
