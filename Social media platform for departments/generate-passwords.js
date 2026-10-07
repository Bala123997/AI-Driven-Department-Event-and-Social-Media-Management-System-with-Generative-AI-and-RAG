import 'dotenv/config';
import bcrypt from 'bcryptjs';

const passwords = [
  ['faculty@kare.edu', process.env.TEST_FACULTY_PASSWORD],
  ['coordinator@kare.edu', process.env.TEST_COORDINATOR_PASSWORD],
  ['admin@kare.edu', process.env.TEST_ADMIN_PASSWORD],
  ['general@kare.edu', process.env.TEST_GENERAL_PASSWORD]
];

(async () => {
  if (passwords.some(([, password]) => !password)) {
    throw new Error('Set TEST_*_PASSWORD values in .env before generating hashes.');
  }

  console.log('Generated bcrypt hashes (rounds: 10):\n');
  for (const [email, password] of passwords) {
    const hash = await bcrypt.hash(password, 10);
    console.log(`${email}:`);
    console.log(`  Hash: ${hash}\n`);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
