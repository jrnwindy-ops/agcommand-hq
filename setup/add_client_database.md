# Connecting a client database to HQ

Each client has its own AgCommand database. HQ reads **aggregate statistics only**
from it through `agc_client_stats(token)`; it never reads records.

1. In the **client** database, the function `public.agc_client_stats(p_token text)`
   and the tables `agc_private.meta` and `agc_private.collector_tokens` must exist
   (client repository migration *hq_aggregate_stats_endpoint*).
2. Make a token and store only its hash in the **client** database:
   ```sql
   -- generate locally:  python3 -c "import secrets; print('agc_col_'+secrets.token_hex(32))"
   insert into agc_private.collector_tokens(id, token_hash, note)
   values ('hq-<TENANT_ID>', encode(extensions.digest('<TOKEN>', 'sha256'), 'hex'), 'AgCommand HQ collector');
   ```
3. In the HQ console: open the client → **Collector connection** → paste the database
   address (`https://<ref>.supabase.co`), its publishable key and the token → Save.
4. **Collect now**. The client's row shows acres, blocks and health within a minute.

To revoke: `update agc_private.collector_tokens set revoked_at = now() where id = 'hq-<TENANT_ID>';`
