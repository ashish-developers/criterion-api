-- A vendor who had accepted a job that the customer then cancelled earns the setup and blank
-- charges the customer is charged for that line (Section 7.6). Recorded as a commission line of
-- its own kind, payable in the vendor's next settlement.
ALTER TABLE commissions DROP CONSTRAINT commissions_model_check;
ALTER TABLE commissions ADD CONSTRAINT commissions_model_check CHECK (model IN ('marketplace','job_rate','cancellation'));
