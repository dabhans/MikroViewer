// Well-known ports → service name, so 443 shows as "HTTPS".

const SERVICES: Record<string, string> = {
  'tcp:20': 'FTP-DATA',
  'tcp:21': 'FTP',
  'tcp:22': 'SSH',
  'tcp:23': 'TELNET',
  'tcp:25': 'SMTP',
  'tcp:53': 'DNS',
  'udp:53': 'DNS',
  'udp:67': 'DHCP',
  'udp:68': 'DHCP',
  'tcp:80': 'HTTP',
  'tcp:110': 'POP3',
  'udp:123': 'NTP',
  'udp:137': 'NETBIOS',
  'udp:138': 'NETBIOS',
  'tcp:139': 'NETBIOS',
  'tcp:143': 'IMAP',
  'udp:161': 'SNMP',
  'tcp:443': 'HTTPS',
  'udp:443': 'QUIC',
  'tcp:445': 'SMB',
  'tcp:465': 'SMTPS',
  'udp:500': 'IKE',
  'udp:514': 'SYSLOG',
  'tcp:587': 'SMTP',
  'tcp:631': 'IPP',
  'tcp:853': 'DNS-TLS',
  'tcp:993': 'IMAPS',
  'tcp:995': 'POP3S',
  'tcp:1194': 'OPENVPN',
  'udp:1194': 'OPENVPN',
  'tcp:1723': 'PPTP',
  'tcp:1883': 'MQTT',
  'udp:1900': 'SSDP',
  'tcp:3074': 'XBOX',
  'udp:3074': 'XBOX',
  'tcp:3389': 'RDP',
  'udp:3478': 'STUN',
  'udp:3479': 'STUN',
  'udp:3480': 'STUN',
  'udp:4500': 'IPSEC-NAT-T',
  'udp:5060': 'SIP',
  'tcp:5060': 'SIP',
  'tcp:5222': 'XMPP',
  'tcp:5223': 'APNS',
  'tcp:5228': 'GCM',
  'udp:5353': 'MDNS',
  'tcp:6881': 'BITTORRENT',
  'udp:6881': 'BITTORRENT',
  'tcp:8080': 'HTTP-ALT',
  'tcp:8291': 'WINBOX',
  'tcp:8443': 'HTTPS-ALT',
  'tcp:8728': 'ROS-API',
  'tcp:8729': 'ROS-API-SSL',
  'tcp:8883': 'MQTTS',
  'tcp:9100': 'JETDIRECT',
  'udp:19302': 'STUN',
  'udp:51820': 'WIREGUARD'
}

export function serviceName(protocol: string, port: number | undefined): string | undefined {
  if (port === undefined) return undefined
  return SERVICES[`${protocol}:${port}`]
}

/** "HTTPS (TCP/443)", "TCP/8443" or "ICMP" – the service column of firewall log consoles. */
export function serviceLabel(protocol: string, port: number | undefined): string {
  const proto = protocol.toUpperCase()
  if (port === undefined) return proto
  const name = serviceName(protocol, port)
  return name ? `${name} (${proto}/${port})` : `${proto}/${port}`
}
