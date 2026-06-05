module.exports = {
  apps: [{
    name: 'nibrs',
    script: 'node_modules/next/dist/bin/next',
    args: 'start',
    cwd: '/opt/nibrs/current',
    instances: 4,
    exec_mode: 'cluster',
    env: {
      RTCI_DB_PATH: '/opt/nibrs/shared/crime_data.db',
      NIBRS_DB_PATH: '/opt/nibrs/nibrs.db',
      SHR_DB_PATH: '/opt/nibrs/shr.db',
      QUERY_LOG_DB_PATH: '/opt/nibrs/shared/query_log.db',
      APP_DIR: '/opt/nibrs/current',
    },
  }],
};
