import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChromaWhereFilter } from '../api/services/chroma-service.js';
import { buildRagContext, buildRagPrompt, buildUserRagContext, evaluateRetrieval, filterRegisteredEvents, formatCalendarEvents, formatRegisteredEvents, findEventTypeMatches, formatEventTypeAnswer, findKeywordMatches, getCalendarScope, getRegistrationFilter, isCalendarCountQuestion, isCalendarListQuestion, isEventTypeQuestion, isRegistrationQuestion, isRegistrationStatusQuestion, mapRetrievedPosts, selectRelevantPosts } from '../api/services/rag-service.js';

test('buildRagContext includes approved event details for the LLM', () => {
  const posts = [
    {
      post_id: 1,
      title: 'KARE CSE Hackathon 2026',
      description: '24-hour coding hackathon',
      post_type: 'hackathon',
      event_date: '2026-10-15',
      event_time: '09:00:00',
      venue: 'CSE Block',
    },
  ];

  const context = buildRagContext(posts);

  assert.match(context, /KARE CSE Hackathon 2026/);
  assert.match(context, /CSE Block/);
  assert.match(context, /24-hour coding hackathon/);
});

test('selectRelevantPosts picks the most relevant approved events', () => {
  const questionEmbedding = [1, 0, 0, 0];
  const posts = [
    { title: 'AI Workshop', ai_embedding: [0.2, 0.9, 0, 0] },
    { title: 'Hackathon', ai_embedding: [1, 0, 0, 0] },
    { title: 'Placement Drive', ai_embedding: [0, 0, 1, 0] },
  ];

  const matches = selectRelevantPosts(questionEmbedding, posts, 2);

  assert.equal(matches[0].title, 'Hackathon');
  assert.equal(matches.length, 2);
});

test('RAG context can only use Chroma results that remain in the approved SQL result set', () => {
  const approvedPosts = [
    { post_id: 11, title: 'AI Workshop' },
    { post_id: 12, title: 'Hackathon' },
  ];
  const retrievedPosts = mapRetrievedPosts(['12', '999'], approvedPosts);
  const context = buildUserRagContext({ calendarEvents: retrievedPosts });

  assert.deepEqual(retrievedPosts.map((post) => post.title), ['Hackathon']);
  assert.match(context, /Hackathon/);
  assert.doesNotMatch(context, /AI Workshop/);
  assert.doesNotMatch(context, /999/);
});

test('retrieved context is unique and capped at top five approved SQL matches', () => {
  const approvedPosts = Array.from({ length: 7 }, (_, index) => ({ post_id: index + 1, title: `Event ${index + 1}` }));
  const retrievedPosts = mapRetrievedPosts(['1', '2', '2', '999', '3', '4', '5', '6', '7'], approvedPosts);

  assert.deepEqual(retrievedPosts.map((post) => post.post_id), [1, 2, 3, 4, 5]);
});

test('retrieval evaluation reports Precision@K, Recall@K, and MRR', () => {
  assert.deepEqual(evaluateRetrieval(['a', 'b', 'c', 'd'], ['b', 'd'], 4), {
    precisionAtK: 0.5,
    recallAtK: 1,
    reciprocalRank: 0.5,
  });
});

test('Chroma retrieval is limited to approved events in the requested calendar scope', () => {
  assert.deepEqual(buildChromaWhereFilter({ start: '2026-09-25', end: '2026-10-31' }), {
    $and: [
      { status: { $in: ['approved', 'scheduled', 'published'] } },
      { event_date_key: { $gte: 20260925 } },
      { event_date_key: { $lte: 20261031 } },
    ],
  });
});

test('buildRagPrompt provides the authoritative current date and calendar window', () => {
  const prompt = buildRagPrompt('What is happening this month?', 'Title: September Workshop', '2026-09-24');

  assert.match(prompt, /Current date: 2026-09-24/);
  assert.match(prompt, /Requested calendar scope: current-month/);
  assert.match(prompt, /2026-09-24 through 2026-09-30/);
});

test('getCalendarScope keeps this-month questions inside the current month', () => {
  assert.deepEqual(getCalendarScope('What events are happening this month?', '2026-09-24'), {
    scope: 'current-month',
    start: '2026-09-24',
    end: '2026-09-30',
  });
});

test('registration questions are answered from the user registration list', () => {
  assert.equal(isRegistrationQuestion('What events am I registered for?'), true);
  assert.equal(isRegistrationStatusQuestion('Show my registration details'), true);
  assert.equal(getRegistrationFilter('What hackathons did I register for?'), 'hackathon');
  assert.equal(getRegistrationFilter('What hacktons did I register for?'), 'hackathon');
  assert.equal(getRegistrationFilter('What events am I registered for?'), '');
  assert.equal(filterRegisteredEvents([
    { title: 'AI Workshop', post_type: 'workshop' },
    { title: 'KARE Coding Hackathon', post_type: 'hackathon' },
  ], 'What hackathons did I register for?').length, 1);
  assert.equal(formatRegisteredEvents([{ title: 'AI Workshop', event_date: '2026-09-28', event_time: '10:00:00', venue: 'Seminar Hall' }]), 'AI Workshop (28 Sep 2026, 10:00 AM)');
  assert.equal(formatRegisteredEvents([]), 'You are not registered for any upcoming events.');
});

test('user RAG context keeps calendar and registration data distinct', () => {
  const context = buildUserRagContext({
    calendarEvents: [{ title: 'AI Workshop', event_date: '2026-09-28', event_time: '10:00:00', venue: 'Seminar Hall' }],
    registeredEvents: [{ title: 'Coding Contest', event_date: '2026-09-30', event_time: '09:00:00', venue: 'Lab 3' }],
  });

  assert.match(context, /APPROVED EVENTS IN THE CURRENT CALENDAR/);
  assert.match(context, /EVENTS REGISTERED BY THIS USER/);
  assert.match(context, /AI Workshop/);
  assert.match(context, /Coding Contest/);
});

test('calendar list questions return all events in the requested scope', () => {
  const events = [
    { title: 'AI Workshop', event_date: '2026-09-28', event_time: '10:00:00', venue: 'Seminar Hall' },
    { title: 'Coding Contest', event_date: '2026-09-30', event_time: '09:00:00', venue: 'Lab 3' },
  ];
  assert.equal(isCalendarListQuestion('What events are happening this month?'), true);
  assert.equal(findKeywordMatches('What events are happening this month?', events).length, 0);
  assert.equal(formatCalendarEvents(events), 'AI Workshop (28 Sep 2026, 10:00 AM)\nCoding Contest (30 Sep 2026, 9:00 AM)');
  assert.equal(isCalendarCountQuestion('How many events are happening this month?'), true);
});

test('event type questions answer from the stored event category', () => {
  const events = [{ title: 'Pitch Deck', post_type: 'hackathon' }, { title: 'Notification Check Event', post_type: 'event' }];
  assert.equal(isEventTypeQuestion('Is Pitch Deck a hackathon?'), true);
  const match = findEventTypeMatches('Is Pitch Deck a hackathon?', events)[0];
  assert.equal(formatEventTypeAnswer(match, 'hackathon'), 'Yes. Pitch Deck is a Hackathon.');
  assert.equal(formatEventTypeAnswer(events[1], 'hackathon'), 'No. Notification Check Event is an Event, not a hackathon.');
});
