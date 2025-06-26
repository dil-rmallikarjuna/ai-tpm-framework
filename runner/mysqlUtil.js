const mysql = require('mysql2/promise');

const dbConfig = {
  host: '10.10.2.27',
  user: 'devadmin',
  password: 'DcuAdDIOG7pYjZGSyDOZCqjzl9bWF',
  port: 3306,
};

async function runQuery(query, database = null) {
  const config = { ...dbConfig };
  if (database) config.database = database;
  const connection = await mysql.createConnection(config);
  try {
    const [rows] = await connection.execute(query);
    return rows;
  } finally {
    await connection.end();
  }
}

module.exports = { runQuery };