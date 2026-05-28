module.exports = {
  apps: [{
    name: 'nibrs',
    script: 'npm',
    args: 'start',
    cwd: '/opt/nibrs/app',
    instances: 4,
    exec_mode: 'cluster',
    env: {
      RTCI_DB_PATH: '/opt/nibrs/app/crime_data.db',
      NIBRS_DB_PATH: '/opt/nibrs/nibrs.db',
      SHR_DB_PATH: '/opt/nibrs/shr.db',
      QUERY_LOG_DB_PATH: '/opt/nibrs/app/query_log.db',
      APP_DIR: '/opt/nibrs/app',
    },
  }],
};
