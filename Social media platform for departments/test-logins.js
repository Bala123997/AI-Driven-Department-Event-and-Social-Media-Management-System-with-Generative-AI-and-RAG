import "dotenv/config";

const tests = [
  { role: 'faculty', email: 'faculty@kare.edu', password: process.env.TEST_FACULTY_PASSWORD, label: 'Faculty' },
  { role: 'coordinator', email: 'coordinator@kare.edu', password: process.env.TEST_COORDINATOR_PASSWORD, label: 'Coordinator' },
  { role: 'admin', email: 'admin@kare.edu', password: process.env.TEST_ADMIN_PASSWORD, label: 'Admin' },
  { role: 'general', email: 'general@kare.edu', password: process.env.TEST_GENERAL_PASSWORD, label: 'General User' }
];

if (tests.some(({ password }) => !password)) {
  console.error('Set TEST_*_PASSWORD values in .env before testing logins.');
  process.exitCode = 1;
} else {
  (async () => {
    console.log('\n🧪 Testing all role logins:\n');

    for (const test of tests) {
      try {
        const response = await fetch('http://localhost:3001/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: test.email, password: test.password, role: test.role })
        });

        const data = await response.json();

        if (response.ok) {
          console.log(`✅ ${test.label}: ${data.user.role}`);
        } else {
          console.log(`❌ ${test.label}: ${data.error}`);
        }
      } catch (err) {
        console.log(`❌ ${test.label}: ${err.message}`);
      }
    }

    console.log('\n✨ Done!\n');
  })();
}
