# MikroViewer

A desktop program for monitoring MikroTik routers. It runs entirely on your own computer and talks directly to the router's API – no server, no cloud, nothing to host.

## What it shows

- **Dashboard** – system information, CPU, memory, disk, temperature and other sensors, WAN traffic and the most active devices
- **Connections** – live connection table: protocol, source, destination, port, service, state and current traffic. Can be grouped by source.
- **Connection Log** – every connection that opens or closes, with source, destination, destination port, duration and bytes. Can be exported to CSV.
- **DHCP Leases** – IP, MAC, hostname, status and expiry
- **Interfaces** – status, current traffic and totals
- **System Log** – the router's own log

Several routers can be added. They stay connected at the same time, and you switch between them in the menu on the left.

## Getting started

### 1. Prepare the router

Enable the API service (Winbox/WebFig: **IP → Services → api**, or in the terminal):

```
/ip service enable api
```

Recommended: create a user that can only read. MikroViewer never changes anything on the router.

```
/user add name=mikroviewer group=read password=YourPassword
```

### 2. Install MikroViewer

Run `MikroViewer-Setup-0.1.0.exe`, or use `MikroViewer-0.1.0-portable.exe`, which runs without installation.

The program is not code-signed, so Windows SmartScreen may show a warning the first time. Choose **More info → Run anyway**.

### 3. Add the router

Click **+** next to **Routers**, then enter the router's address, username and password. Use **Test** to check the connection, then **OK**.

## Good to know

- **Connection log:** the log is built while MikroViewer is connected, by comparing the router's connection table every 3 seconds. Very short connections may be missed. It holds up to 20,000 entries in memory; use **Export CSV** to keep them.
- **Busy routers:** above 20,000 simultaneous connections, only the count is shown, to avoid loading the router.
- **IPv4 only:** connections are read from the IPv4 connection tracking table.
- **TLS:** api-ssl (port 8729) requires a certificate on the router. MikroViewer remembers the certificate on the first connection and warns if it changes.
- **Stored data:** router profiles are saved in `%APPDATA%\MikroViewer\routers.json`. Passwords are encrypted with Windows' own encryption (DPAPI).

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

The project includes a simulated router with realistic data:

```bash
npm run mock
```

Then add a router with address `127.0.0.1`, port `8728`, user `admin` and password `admin`.
