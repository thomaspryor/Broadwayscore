export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'cyrus-relay',
    relaySecretConfigured: Boolean(process.env.RELAY_SECRET),
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  });
}
