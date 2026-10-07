import "dotenv/config";
import bcrypt from "bcryptjs";

const passwords = [
  { role: "Faculty", password: process.env.TEST_FACULTY_PASSWORD },
  { role: "Student Coordinator", password: process.env.TEST_COORDINATOR_PASSWORD },
  { role: "Admin", password: process.env.TEST_ADMIN_PASSWORD },
  { role: "General User", password: process.env.TEST_GENERAL_PASSWORD }
];

async function generateHashes() {
  if (passwords.some(({ password }) => !password)) {
    throw new Error("Set TEST_*_PASSWORD values in .env before generating hashes.");
  }

  console.log("\n=== BCRYPT PASSWORD HASHES ===\n");
  for (const item of passwords) {
    const hash = await bcrypt.hash(item.password, 10);
    console.log(`${item.role}:`);
    console.log(`  Hash: ${hash}\n`);
  }
}

generateHashes().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
