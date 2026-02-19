require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const client = require("../utils/mongo");

const run = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI 未设置");
    process.exit(1);
  }

  try {
    await client.connect();
    const admin = client.db().admin();
    const result = await admin.ping();
    console.log("MongoDB 连接成功:", result);
  } catch (err) {
    console.error("MongoDB 连接失败:", err);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
};

run();
