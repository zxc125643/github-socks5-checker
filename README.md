# GitHub SOCKS5 daily checker + edgetunnel

This repository template:

1. Fetches public SOCKS5 lists every day at 02:15 UTC (10:15 Asia/Shanghai).
2. Checks candidates through `https://check.socks5.cmliussss.net/check`.
3. Ranks working nodes by risk score first and latency second.
4. Publishes `data/socks5.json`, `data/socks5.txt`, `data/results.json`, and `data/status.json`.
5. Lets the edgetunnel admin page use the generated JSON in its existing "获取更多 SOCKS5" dialog.

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

The script uses the same abuse-score formula shown by the checker site. It excludes bogon, Tor, VPN, and data-center exits from the preferred list, then sorts by risk score and response time. If no preferred nodes survive, it publishes the lowest-risk usable nodes so that the output does not silently become empty.

Public free proxies are untrusted. Never send credentials, private traffic, payment data, or other sensitive information through them.
