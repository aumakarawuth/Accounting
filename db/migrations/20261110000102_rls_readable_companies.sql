-- migrate:up
-- ความเร็ว (docs/performance.md): policy อ่านเดิมเรียก app.can_read_company(company_id) ทุกแถว
-- (บริษัท 3,000 รายการ = เรียก 3,000 ครั้งต่อคำสั่ง) เปลี่ยนเป็นเทียบกับชุด id บริษัทที่อ่านได้ ซึ่ง Postgres คำนวณครั้งเดียวต่อคำสั่ง
-- สิทธิ์เท่าเดิมทุกประการ: เจ้าของบริษัท หรือครูประจำห้องของบริษัทที่บัญชียังใช้งานอยู่ (ตรงกับ app.can_read_company)
create function app.readable_company_ids() returns setof uuid
language sql stable security definer set search_path = acc, pg_temp as $$
  select c.id from acc.companies c where c.owner_id = app.current_user_id()
  union all
  select c.id from acc.companies c
    join acc.classrooms r on r.id = c.classroom_id
    join acc.users u on u.id = r.teacher_id and u.active
   where r.teacher_id = app.current_user_id()
$$;
revoke all on function app.readable_company_ids() from public;
grant execute on function app.readable_company_ids() to app_rw, app_ro;

alter policy balances_read on acc.account_balances using ((company_id in (select app.readable_company_ids())));
alter policy allocations_read on acc.allocations using ((company_id in (select app.readable_company_ids())));
alter policy asset_disposals_read on acc.asset_disposals using ((company_id in (select app.readable_company_ids())));
alter policy bank_matches_read on acc.bank_reconciliation_matches using ((company_id in (select app.readable_company_ids())));
alter policy bank_lines_read on acc.bank_statement_lines using ((company_id in (select app.readable_company_ids())));
alter policy bank_statements_read on acc.bank_statements using ((company_id in (select app.readable_company_ids())));
alter policy coa_read on acc.chart_of_accounts using ((company_id in (select app.readable_company_ids())));
alter policy cheque_events_read on acc.cheque_events using ((company_id in (select app.readable_company_ids())));
alter policy cheques_read on acc.cheques using ((company_id in (select app.readable_company_ids())));
alter policy comments_read on acc.comments using (((deleted_at IS NULL) AND (company_id in (select app.readable_company_ids()))));
alter policy companies_read on acc.companies using ((id in (select app.readable_company_ids())));
alter policy depreciation_lines_read on acc.depreciation_lines using ((company_id in (select app.readable_company_ids())));
alter policy depreciation_runs_read on acc.depreciation_runs using ((company_id in (select app.readable_company_ids())));
alter policy document_lines_read on acc.document_lines using ((company_id in (select app.readable_company_ids())));
alter policy documents_read on acc.documents using ((company_id in (select app.readable_company_ids())));
alter policy exam_attempts_read on acc.exam_attempts using ((company_id in (select app.readable_company_ids())));
alter policy fixed_assets_read on acc.fixed_assets using ((company_id in (select app.readable_company_ids())));
alter policy inventory_document_posts_read on acc.inventory_document_posts using ((company_id in (select app.readable_company_ids())));
alter policy inventory_movements_read on acc.inventory_movements using ((company_id in (select app.readable_company_ids())));
alter policy items_read on acc.items using ((company_id in (select app.readable_company_ids())));
alter policy entries_read on acc.journal_entries using ((company_id in (select app.readable_company_ids())));
alter policy lines_read on acc.journal_lines using ((company_id in (select app.readable_company_ids())));
alter policy parties_read on acc.parties using ((company_id in (select app.readable_company_ids())));
alter policy periods_read on acc.periods using ((company_id in (select app.readable_company_ids())));
alter policy presence_read on acc.presence using ((company_id in (select app.readable_company_ids())));
alter policy purchase_allocations_read on acc.purchase_allocations using ((company_id in (select app.readable_company_ids())));
alter policy purchase_lines_read on acc.purchase_document_lines using ((company_id in (select app.readable_company_ids())));
alter policy purchase_documents_read on acc.purchase_documents using ((company_id in (select app.readable_company_ids())));
alter policy submission_events_read on acc.submission_events using ((company_id in (select app.readable_company_ids())));
alter policy submissions_read on acc.submissions using ((company_id in (select app.readable_company_ids())));
alter policy vat_closings_read on acc.vat_closings using ((company_id in (select app.readable_company_ids())));
alter policy wht_certificates_read on acc.wht_certificates using ((company_id in (select app.readable_company_ids())));
alter policy wht_remittances_read on acc.wht_remittances using ((company_id in (select app.readable_company_ids())));

-- migrate:down
alter policy balances_read on acc.account_balances using (app.can_read_company(company_id));
alter policy allocations_read on acc.allocations using (app.can_read_company(company_id));
alter policy asset_disposals_read on acc.asset_disposals using (app.can_read_company(company_id));
alter policy bank_matches_read on acc.bank_reconciliation_matches using (app.can_read_company(company_id));
alter policy bank_lines_read on acc.bank_statement_lines using (app.can_read_company(company_id));
alter policy bank_statements_read on acc.bank_statements using (app.can_read_company(company_id));
alter policy coa_read on acc.chart_of_accounts using (app.can_read_company(company_id));
alter policy cheque_events_read on acc.cheque_events using (app.can_read_company(company_id));
alter policy cheques_read on acc.cheques using (app.can_read_company(company_id));
alter policy comments_read on acc.comments using (((deleted_at IS NULL) AND app.can_read_company(company_id)));
alter policy companies_read on acc.companies using (app.can_read_company(id));
alter policy depreciation_lines_read on acc.depreciation_lines using (app.can_read_company(company_id));
alter policy depreciation_runs_read on acc.depreciation_runs using (app.can_read_company(company_id));
alter policy document_lines_read on acc.document_lines using (app.can_read_company(company_id));
alter policy documents_read on acc.documents using (app.can_read_company(company_id));
alter policy exam_attempts_read on acc.exam_attempts using (app.can_read_company(company_id));
alter policy fixed_assets_read on acc.fixed_assets using (app.can_read_company(company_id));
alter policy inventory_document_posts_read on acc.inventory_document_posts using (app.can_read_company(company_id));
alter policy inventory_movements_read on acc.inventory_movements using (app.can_read_company(company_id));
alter policy items_read on acc.items using (app.can_read_company(company_id));
alter policy entries_read on acc.journal_entries using (app.can_read_company(company_id));
alter policy lines_read on acc.journal_lines using (app.can_read_company(company_id));
alter policy parties_read on acc.parties using (app.can_read_company(company_id));
alter policy periods_read on acc.periods using (app.can_read_company(company_id));
alter policy presence_read on acc.presence using (app.can_read_company(company_id));
alter policy purchase_allocations_read on acc.purchase_allocations using (app.can_read_company(company_id));
alter policy purchase_lines_read on acc.purchase_document_lines using (app.can_read_company(company_id));
alter policy purchase_documents_read on acc.purchase_documents using (app.can_read_company(company_id));
alter policy submission_events_read on acc.submission_events using (app.can_read_company(company_id));
alter policy submissions_read on acc.submissions using (app.can_read_company(company_id));
alter policy vat_closings_read on acc.vat_closings using (app.can_read_company(company_id));
alter policy wht_certificates_read on acc.wht_certificates using (app.can_read_company(company_id));
alter policy wht_remittances_read on acc.wht_remittances using (app.can_read_company(company_id));
drop function app.readable_company_ids();
