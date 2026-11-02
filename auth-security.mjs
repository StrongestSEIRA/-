// Only call after the provider has validated the access token.
export function hasRecentOtpProof(token,now=Date.now()){
 try{const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());return Array.isArray(claims.amr)&&claims.amr.some(a=>a.method==='otp'&&Number.isFinite(a.timestamp)&&a.timestamp<=now/1000+30&&now/1000-a.timestamp<=600);}catch{return false;}
}
export function clientAddress(req,trustProxy=false){
 if(trustProxy&&typeof req.headers['x-forwarded-for']==='string')return req.headers['x-forwarded-for'].split(',').at(-1).trim();
 return req.socket.remoteAddress||'unknown';
}
