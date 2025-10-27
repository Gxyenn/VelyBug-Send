const { MongoClient } = require("mongodb");

// ###################################################################################
// ##                                                                                 ##
// ##   SILAKAN GANTI "YOUR_MONGO_CONNECTION_STRING" DENGAN KONEKSI STRING MONGO ANDA   ##
// ##                                                                                 ##
// ###################################################################################
const uri = process.env.MONGO_URI || "YOUR_MONGO_CONNECTION_STRING";


const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function connect() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB", error);
    process.exit(1);
  }
}

function getDB() {
  return client.db();
}

module.exports = { connect, getDB };
