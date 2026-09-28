CREATE SCHEMA app;
CREATE FUNCTION app.f() RETURNS void AS $$
BEGIN
  PERFORM set_config('search_path', 'auth', false);
END
$$ LANGUAGE plpgsql;
