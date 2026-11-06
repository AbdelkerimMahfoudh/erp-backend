-- 0131: who the automatic trial would reach, by category — counts only, never a contact or a name (docs/121).
-- Read-only. Run as the backup or read-only account before enabling AUTOMATIC_TRIAL in an environment.
SELECT category, COUNT(*) AS businesses FROM (
  SELECT
    CASE
      WHEN c.deleted_at IS NOT NULL OR c.closed_at IS NOT NULL OR c.is_active = 0 THEN 'closed_or_deleted'
      WHEN c.is_test = 1 THEN 'test_business'
      WHEN tc.company_id IS NOT NULL AND tc.idempotency_key LIKE 'auto:%' THEN 'trial_started_automatically'
      WHEN tc.company_id IS NOT NULL THEN 'trial_claimed_by_link'
      WHEN te.company_id IS NULL THEN 'console_created_no_eligibility'
      WHEN te.closed_at IS NOT NULL THEN 'eligibility_closed'
      WHEN s.status IN ('rejected') THEN 'refused'
      WHEN s.status IN ('suspended') THEN 'suspended'
      WHEN s.status IN ('cancelled') THEN 'cancelled'
      WHEN s.is_complimentary = 1 THEN 'granted'
      WHEN s.current_period_end IS NOT NULL THEN 'paid_or_approved'
      WHEN (te.registration_method IN ('phone', 'both') AND u.phone_verified_at IS NULL)
        OR (te.registration_method IN ('email', 'both') AND u.email_verified_at IS NULL) THEN 'eligible_contact_unverified'
      ELSE 'eligible_unclaimed_ready'
    END AS category
  FROM companies c
  LEFT JOIN subscriptions s ON s.company_id = c.id
  LEFT JOIN trial_eligibilities te ON te.company_id = c.id
  LEFT JOIN trial_claims tc ON tc.company_id = c.id
  LEFT JOIN users u ON u.id = te.owner_user_id
) x
GROUP BY category
ORDER BY category;
