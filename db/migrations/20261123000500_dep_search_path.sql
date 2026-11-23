-- migrate:up
-- ล็อก search_path ของฟังก์ชันคำนวณค่าเสื่อม (Supabase security advisor: function_search_path_mutable)
alter function app.daily_depreciation_cum(numeric, numeric, date, integer, date) set search_path = app, pg_temp;
alter function app.dep_cum(text, numeric, numeric, date, date, integer, integer) set search_path = app, pg_temp;
alter function app.dep_total_months(text, date, date, integer) set search_path = app, pg_temp;

-- migrate:down
alter function app.daily_depreciation_cum(numeric, numeric, date, integer, date) reset search_path;
alter function app.dep_cum(text, numeric, numeric, date, date, integer, integer) reset search_path;
alter function app.dep_total_months(text, date, date, integer) reset search_path;
