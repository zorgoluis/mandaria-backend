// Local fixed-destination ingress only. No credentials, arbitrary URLs or outbound proxy API.
const http = require('node:http');
const net = require('node:net');
http.createServer((req, res) => {
  const upstream = http.request({ hostname:'backend', port:3000, method:req.method, path:req.url, headers:{...req.headers,host:'backend:3000'} }, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Local backend unavailable');});
  req.on('aborted',()=>upstream.destroy());
  req.pipe(upstream);
}).listen(3000,'0.0.0.0');
net.createServer(client=>{
  const upstream=net.connect({host:'postgres',port:5432});
  upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
  client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
  client.pipe(upstream).pipe(client);
}).listen(5432,'0.0.0.0');
