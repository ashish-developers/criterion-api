-- Register the ticket assignment permissions (014) and give them to the platform admin role
-- straight away, so assignment works on an existing database before the next
-- `npm run seed:reference` (which keeps them in sync).
INSERT INTO permissions (code, module, description) VALUES
  ('tickets.assign',   'support', 'Assign and reassign support tickets to any support team member'),
  ('tickets.view_all', 'support', 'See every support ticket, including those assigned to other team members')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'platform_admin' AND p.code IN ('tickets.assign', 'tickets.view_all')
ON CONFLICT DO NOTHING;
