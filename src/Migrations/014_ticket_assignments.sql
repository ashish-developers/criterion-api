-- Support ticket assignment history: who a ticket was assigned to, by whom and when. The
-- current assignee stays on tickets.assigned_to; each change (assign, reassign, unassign,
-- an agent picking up an unassigned ticket) adds a row here.
CREATE TABLE ticket_assignments (
  id            BIGSERIAL PRIMARY KEY,
  ticket_id     UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  note          VARCHAR(300),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ticket_assignments_ticket_idx ON ticket_assignments (ticket_id, created_at);

-- "Assigned to me" and "Unassigned" filters.
CREATE INDEX tickets_assigned_idx ON tickets (assigned_to);
