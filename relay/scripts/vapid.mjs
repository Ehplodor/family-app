// Génère la paire de clés VAPID du relais (identification auprès des services push).
const { webcrypto: crypto } = await import('node:crypto');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const raw = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const priv = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });

if (process.argv.includes('--dev-vars')) {
  // En développement : limites relâchées (tests répétés depuis la même machine) et tout site local autorisé.
  console.log(
    `VAPID_PUBLIC_KEY=${raw}\nVAPID_PRIVATE_JWK=${priv}\nALLOWED_ORIGINS=*\nNEW_CIRCLES_PER_IP_PER_DAY=1000\nNEW_CIRCLES_PER_DAY=100000\nCIRCLE_QUOTA_START_MB=250`,
  );
} else {
  console.log('Clé publique (à mettre dans wrangler.toml, [vars] VAPID_PUBLIC_KEY) :\n');
  console.log(`  ${raw}\n`);
  console.log('Clé privée (SECRÈTE) — à coller quand `npx wrangler secret put VAPID_PRIVATE_JWK` la demande :\n');
  console.log(`  ${priv}\n`);
}
