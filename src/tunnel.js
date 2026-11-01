import net from 'node:net';

// A local forwarder on 127.0.0.1:<random>: every accepted connection is spliced to one fresh upstream from
// `connect()` (resolving `{socket, head}`). Clients therefore address the browser as 127.0.0.1:<tunnel port>,
// which passes Chromium's Host check, and Chromium's own URLs already point back at the tunnel.
// A failed upstream destroys the client and is kept as `lastError`; `close()` destroys every socket.
export function openTunnel(connect) {
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  const tunnel = { port: null, lastError: null, closed: false };

  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (client) => {
    track(client);
    if (tunnel.closed) { client.destroy(); return; }
    connect().then(({ socket: up, head }) => {
      track(up);
      if (tunnel.closed || client.destroyed) { up.destroy(); client.destroy(); return; }
      tunnel.lastError = null;
      const end = () => { client.destroy(); up.destroy(); };
      client.on('close', end);
      up.on('close', end);
      if (head?.length) client.write(head);
      client.pipe(up);
      up.pipe(client);
      up.resume();
      client.resume();
    }, (err) => {
      tunnel.lastError = err;
      client.destroy();
    });
  });

  tunnel.close = () => {
    if (tunnel.closed) return;
    tunnel.closed = true;
    server.close();
    for (const s of sockets) s.destroy();
    sockets.clear();
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { tunnel.port = server.address().port; resolve(tunnel); });
  });
}
