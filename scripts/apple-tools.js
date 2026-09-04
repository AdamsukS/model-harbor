/* Runs only inside macOS JavaScript for Automation, with data passed as argv. */
function run(argv) {
  var operation = argv[0];
  var input = JSON.parse(argv[1]);
  if (operation === 'calendar') {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 14) throw new Error('Invalid days');
    var start = new Date();
    var end = new Date(start.getTime() + input.days * 86400000);
    var calendars = Application('Calendar').calendars();
    var events = [];
    for (var c = 0; c < calendars.length && events.length < 50; c++) {
      // ponytail: Calendar scripting does not expand recurring occurrences; use EventKit before relying on free/busy.
      var matches = calendars[c].events.whose({ _and: [{ startDate: { _greaterThan: start } }, { startDate: { _lessThan: end } }] })();
      for (var e = 0; e < matches.length && events.length < 50; e++) {
        events.push({ calendar: calendars[c].name(), title: matches[e].summary(), start: matches[e].startDate().toISOString(), end: matches[e].endDate().toISOString() });
      }
    }
    events.sort(function (a, b) { return a.start.localeCompare(b.start); });
    return JSON.stringify({ events: events, calendarCount: calendars.length, recurringOccurrencesComplete: false, limit: 50 });
  }
  if (operation === 'mail') {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new Error('Invalid limit');
    var mail = Application('Mail');
    var accounts = mail.accounts();
    var inbox = mail.inbox.messages;
    var count = inbox.length;
    var messages = [];
    for (var i = 0; i < Math.min(count, input.limit); i++) {
      var message = inbox[i];
      messages.push({ id: message.id(), subject: message.subject(), sender: message.sender(), received: message.dateReceived().toISOString(), read: message.readStatus() });
    }
    return JSON.stringify({ messages: messages, accountCount: accounts.length, inboxCount: count, headersOnly: true });
  }
  throw new Error('Unknown operation');
}
