-- Custom SQL migration file, put your code below! --

-- Durcissement append-only du journal d'audit : UPDATE et DELETE sur
-- `audit_entries` sont bloqués au niveau SQL (tous rôles, superuser inclus).
-- SQLSTATE personnalisé `IC001` (classe non réservée « IC » = ICOS) afin que le
-- code applicatif reconnaisse l'erreur sans exposer son message brut dans l'API.
-- Note : les triggers ROW BEFORE UPDATE/DELETE ne se déclenchent PAS sur
-- TRUNCATE ; le nettoyage `TRUNCATE ... CASCADE` des tests reste utilisable.

CREATE FUNCTION icos_forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_entries est append-only : % interdit', TG_OP
		USING ERRCODE = 'IC001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_entries_append_only
	BEFORE UPDATE OR DELETE ON audit_entries
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_audit_mutation();
