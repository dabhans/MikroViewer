# MikroViewer

A desktop program for monitoring MikroTik routers. It runs entirely on your own computer and talks directly to the router's API – no server, no cloud, nothing to host.

## What it shows

- **Overview** – system information, CPU, memory, disk, temperature and other sensors, WAN traffic and the most active devices
- **Connections** – live connection table: protocol, source, destination, port, service, state and current traffic. Can be grouped by source.
- **Logs** – a firewall-style log with search, time ranges and a timeline (see [Logs](#logs))
- **DHCP Leases** – IP, MAC, hostname, status and expiry
- **Interfaces** – status, current traffic and totals
- **System Log** – the router's own log

Several routers can be added. They stay connected at the same time, and you switch between them in the menu on the left. Right-click a router to connect, disconnect or edit it.

## Getting started

### 1. Prepare the router

MikroViewer only reads from the router. Create a user that can only read:

```
/user add name=mikroviewer group=read password=YourPassword
```

Then enable the API. Use **api-ssl** (encrypted) if you can, or plain **api** on a trusted network.

#### api-ssl (encrypted, recommended)

api-ssl needs a certificate on the router. A self-signed certificate is fine:

```
/certificate add name=api-ssl common-name=api-ssl days-valid=3650
/certificate sign api-ssl
/ip service set api-ssl certificate=api-ssl disabled=no
```

Signing can take a minute on small routers. `/certificate print` shows the certificate with the flags `K` (private key) and `T` (trusted) when it is ready.

Optionally, turn off the unencrypted API and only allow your own network:

```
/ip service disable api
/ip service set api-ssl address=192.168.88.0/24
```

In MikroViewer, tick **Use TLS (api-ssl)** when adding the router (port 8729). The certificate is remembered on the first connection; if it changes later, MikroViewer refuses to connect. If you replaced the certificate yourself, edit the router and tick **Reset saved certificate**.

#### api (unencrypted)

```
/ip service enable api
```

Port 8728. The password is sent unencrypted, so only use this on a network you trust.

### 2. Install MikroViewer

Run `MikroViewer-Setup-0.2.0.exe`, or use `MikroViewer-0.2.0-portable.exe`, which runs without installation.

The program is not code-signed, so Windows SmartScreen may show a warning the first time. Choose **More info → Run anyway**.

### 3. Add the router

Click **+** next to **Routers**, then enter the router's address, username and password. Use **Test** to check the connection, then **OK**.

## Logs

The log has two kinds of records:

- **Sessions** – every connection through or to the router, from the connection table: source, destination, port, service, NAT, and when it closes, duration and bytes.
- **Firewall** – packets logged by firewall rules with logging turned on, with the action (Accept, Drop, Reject …), the rule's comment, chain and interfaces.

The router only writes firewall records for rules where logging is on. For example, to log what the default firewall drops from the internet:

```
/ip firewall filter set [find comment="defconf: drop all not coming from LAN"] log=yes log-prefix="DROP-IN"
```

**Searching:** pick a time range, type a query and press Enter. Right-click a cell to filter by (or exclude) its value, drag across the timeline to zoom in, and click a record to see all its details. **Queries** has ready-made searches, and **?** lists every field.

| Query | Finds |
| --- | --- |
| `src:192.168.88.23` | traffic from one device (also a name: `src:iphone`) |
| `src:192.168.88.0/24` | a whole subnet |
| `dst:*.netflix.com` | wildcards |
| `port:443`, `port:1-1024`, `port>1024` | destination ports |
| `service:https`, `proto:udp` | services and protocols |
| `action:drop`, `action:block` | dropped (and rejected) traffic |
| `type:firewall`, `type:session` | one kind of record |
| `rule:"drop all"`, `chain:input`, `in:ether1` | firewall rules and interfaces |
| `nat:dstnat` | port forwards |
| `bytes:>100M`, `duration:>1h` | large or long sessions |

Terms next to each other must all match. `OR`, `NOT` and parentheses work as usual, and `field:a,b` matches either value: `(port:80 OR port:443) NOT src:192.168.88.10`.

**Live** shows new records as they arrive. While you scroll down or look at a record, new records wait behind a "new" button so the list doesn't move.

## Settings and updates

**Settings** (bottom left) has the light or dark theme and how long logs are kept. **About** shows the version and checks for updates. The installed version downloads and installs updates itself; the portable version links to the download page.

## Good to know

- **Logs are collected while MikroViewer runs.** Sessions are found by reading the connection table every 3 seconds, so very short connections can be missed. Firewall records arrive as the router writes them.
- **Stored logs:** in `%APPDATA%\MikroViewer\logs`, one file per router per hour, kept for 7 days by default (Settings). They contain IP addresses, names and traffic of the devices on the network.
- **RouterOS versions:** RouterOS 6 and 7, including 7.20 and newer, where the connection table has separate port fields.
- **Busy routers:** above 20,000 simultaneous connections, only the count is shown, to avoid loading the router.
- **IPv4 only:** connections are read from the IPv4 connection tracking table.
- **Router profiles:** saved in `%APPDATA%\MikroViewer\routers.json`. Passwords are encrypted with Windows' own encryption (DPAPI).

## Building from source

Requires Node.js 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

Build the installer and portable exe into `dist/`:

```bash
npm run dist
```

### Demo without a router

The project includes a simulated router with realistic data, firewall rules and firewall log lines:

```bash
npm run mock
```

Then add a router with address `127.0.0.1`, port `8728`, user `admin` and password `admin`. `--ros719` or `--ros6` simulates older RouterOS versions (ports inside the address fields).

### Publishing an update

The installed app looks for updates in the releases of the public repository `dabhans/MikroViewer-releases` (configured in `electron-builder.yml` and `src/main/updater.ts`). The source code can stay private.

1. Set the new version: `npm version minor` (or `patch`).
2. Build and publish, using your GitHub CLI login (`gh auth login`):

```bash
npm run release
```
