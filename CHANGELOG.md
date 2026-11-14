# Changelog

All notable changes to Echo. Write notes for the next release under "Unreleased"; `npm run release` moves them under the new version.

## Unreleased

## [1.3.0] - 2026-11-14

- Echo doesn't say the same answer twice. When what it hears right after answering is unclear (a mishearing, another language, a laugh, a filler word), the answer stands: it asks once what you said, and after that stays quiet.

- Faster turns in games. When it is Echo's move, the board is looked at once by Echo itself and handed over with the call, so a move is one step less, and the pause before its turn is shorter.

- Long, lively conversations start fresh without waiting for a silence. The summary is written while you keep talking and used at the next gap between turns, and a session where Echo is working on the screen starts fresh sooner (with the job carried over).

- "View changes" and "Merge & restart" on a self-improvement's card work again (they did nothing when clicked).

- Quicker first word in long conversations. Echo starts a fresh session a little sooner (the thread and the summary carry over), because measured over three days its first word came later the fuller the session was.

- The first look at the screen is no longer the slow one. Echo keeps its screen reader awake all day (after launch, when the Mac wakes, and whenever it has sat unused for a few minutes, without taking a picture for that), and when a look is slow the retry waits for the one already being read instead of starting a second. Each look is logged with how long taking the picture and reading it took (numbers only).

- The square round something you circled with the light leaves when Echo has answered, when the page scrolls, or after twenty seconds at most. What you circled is still "this" for two minutes. A ring left by a finished job no longer stays behind either.

- Scrolling goes to places. Echo now brings a heading or a line into view in one move, resting near the top, instead of paging and looking again. It knows where the page is after every scroll (and when it has reached the top or the bottom), remembers where the page was for each point you go through, and can go "back where we were". "A little" and "half a page" move that much, far-away words are found with the app's own Find, and "read along" glides the page slowly while you read ("hold", "slower", "faster"). After a big scroll a faint line shows where your eye was. Walk-throughs use the same one-move scroll.

- Keep an eye on it. Tell Echo to watch something ("let me know when the build is done", "tell me when Claude answers") and it does: it checks that window by itself every few seconds, without taking pictures and without the app needing to be in front, and speaks up when it finishes, fails, stops changing, or has been going too long. A small light sits in the corner of the window being watched. Up to three at once; "stop watching" ends it.

- Filling web forms in Chrome is more reliable. The Echo extension now stays paired and reconnects by itself within a few seconds when Echo restarts; if it ever needs pairing again, Echo's window shows one clear prompt with the code. Echo reads and types into rich-text boxes that sit in a frame (like eBay's item description), and when typing won't take in such a box it pastes the text instead, checks it landed, and puts your clipboard back as it was. (Reload the extension in chrome://extensions once after updating.)

- Echo keeps the thread. When you go through things together (three chats, the points of a reply, a list of files) it keeps the list, which ones are done, the one you are on, and anything it wrote that isn't sent yet, so "next", "where were we?" and "send it" are answered at once without reading everything again. Ask to go "one by one" and a walk-through shows one piece and waits for your "next"; cut in with a question and it carries on from that piece afterwards, not from the top. Echo also knows what you actually heard: when your voice cuts its reply short, it is told which part never reached you. And after opening something it checks that it really opened before saying so.

- Echo stays out of talk that isn't for it. Speech in another language is left alone. A reply that only says "I didn't catch that" no longer keeps Echo listening for more, and after two of them in a row it rests until you say its name. "Shhh", "not you" and "I wasn't talking to you" rest it too, and what it overheard is forgotten, not kept as something to do. "The Echo app" now means Echo, not a speaker.

- Echo reads you what it wrote before it sends it: a message, an email, a prompt to another assistant, a command. Pressing Return in Claude or ChatGPT asks first. A command you asked for in Terminal needs one yes, not two. A time you plan around is said with its day. Going through several things together, Echo keeps track of which are done. And "copy this conversation" puts the session on the clipboard.

- Draw with the light. Hold Control and Option and move the mouse: Echo's light follows your pointer and draws. Circle some code, a paragraph, part of a picture, and say what you want ("fix this"), or say nothing and a small box opens right there to type in. What you circled stays outlined, and stays "this" for two minutes. Circling is pointing, never a yes.

- Notes that stay. Ask Echo to pin something ("keep that number on screen") and the line stays as a small note you can drag and close. Up to five, kept across restarts; the menu bar menu can clear them.

- More of the light's moves: it can show two things at once with a second, smaller light; it does one small loop when your pointer stops near it; and it nods or shakes its head along with Echo's own yes or no. Every move is small on purpose (none carries the light more than 5 points, except the spiral when a job is done), and the nod after a step comes at most once every six seconds.

- The light is more alive: it nods when a step works and shakes its head when one doesn't, winds upward and throws sparks when a job is done, traces a slow figure of eight while Echo thinks, leans toward your pointer when it comes near, beats like a heart while it waits for your yes, leaves a comet's tail on a long flight, and marks each stop of a route with a number.

- Echo beside the thing. The words beside Echo's light are now a glass bubble: the answer's colours run round its rim while Echo is saying them and go quiet once said, and a thread of light joins it to the light. When Echo explains something on screen, the whole sentence about each part is in the bubble beside that part and stays while the light does. A step that needs your yes asks right there, beside the thing it is about to press, with its two buttons (the card in the island and the window stays too). And the light at rest is never quite still: it wanders round its place and flits now and then.

- Typed replies. When your last message was typed, Echo's answer comes with a place to type: the island offers its reply field for half a minute (without taking the keyboard; one tap of Control and Option, or a click, puts the cursor there). When Echo asks a question with a small set of answers ("Aisle or window?", "Want me to send it?"), they come as buttons under the field and above the window's message box. Never for an open question, and never while a card is waiting for your yes.

- One way of listening, in three states. Listening: just talk. Resting: Echo hears only its name. Mic off: only a held key or typing reaches it. Say "go quiet" to rest it, "stop listening" to turn the mic off, and its name to wake it. Tap Control and Option twice, or tap the pearl, to switch Listening and Resting; the "more" menu and the menu bar have all three. Echo rests by itself after three quiet minutes, and the mic goes off while the screen is locked. The menu bar icon and the line under the pearl always show the state. In the Mac app the talk key is Control and Option from any app; Space is a space again.

- Echo starts speaking sooner. When you say or type something new while it is still reading out the last answer, the old answer stops and the new one starts (one turn in nine used to wait 10 to 30 seconds behind it). While Echo is working in your apps but idle between requests, a sentence that sounds finished ends after about 0.7 seconds of silence instead of 1.3. Short spoken turns are answered without the model thinking first. `npm run speed -- --since 1d` shows how long first sound takes and where the time goes.

- Echo stays in the conversation: for about a minute after it speaks, what you say next, clearly and at your usual level, is taken as said to it, even when another app has sound going. No more "Was that for me?" in the middle of a talk. It no longer answers its own voice coming back through a call or a screen share. "Go quiet" closes the conversation until you say its name, and a stray word after "thank you" is left alone.

- Sharing your screen is its own kind of step: the card says it shows your screen to the people on the call, one yes covers the two or three clicks it takes, and asking for it in clear words ("call him and share my screen") covers them without a card.

- The light now stays out for the whole job, however long a step takes Echo to think about, and goes home once Echo has gone idle. `npm run light` now measures how far each step's words were from the landing. "Show them what you can do" is a short show (it sees, makes, does, and plays the Sky), never a list.

- The Sky: a new pane beside Talk and Workers where every day you have talked with Echo is a constellation. Each star is one thing you said or typed: further right the later it was, higher the more Echo had to say back, bigger where Echo did something for you. Each day gets a name (The Night Owl, The Maker, The Long Talk…). Click a name and Echo's light flies the day star by star while it plays as a tune: a star's height is its pitch, and the pauses in your day are the rests. Click a star to ring it and see what you said there; drag to walk back through your days. Today's constellation grows as you talk, and the moon fills as the day does. Or just say "show me my sky" or "play my day". It is drawn from times and counts only; a finished day is kept as numbers on your Mac.

- Echo can play along. Ask it to play a game with you (tic-tac-toe, chess, anything turn by turn) and it sets the game up itself, then takes its turn as soon as you have clicked yours: nothing to say or type between moves. Your click is your move, not a take-over; if it lands while Echo is moving, Echo simply looks again. It plays to win and keeps its plans to itself. Escape or "stop" ends it, as does five minutes with no move.

- Quiet mode: say or type "I don't want to speak right now" (or "quiet mode", "text only") and Echo stops using its voice and stops asking you to say things. It types instead. Speak to it, or type "voice on", and its voice is back.

- Echo tries a second way before giving up on a step (a globe that will not scroll may drag), does its own setup clicks instead of asking you to, and no longer promises to build things "tomorrow": when you wish it could do something, it notes the idea on your Mac (`npm run ideas` reads them) and says only that.

- Echo's light now stays where it is between the steps of a job: it goes straight from one thing to the next instead of flying back to the pearl and out again each time (it still comes home when you talk, when the job ends, or when nothing more comes for 15 seconds). Its words are now timed to the landing: the app says how long each flight will take, so "this one" is heard as the light arrives rather than after. And every trip is kept on the timeline (never the words): `npm run light -- --since 30m` reads a session back with each thing the light showed, what Echo said with it (from the conversation log), how far the words were from the landing, and how many times the light went home in the middle of a job.

- Echo has a new look: a calm black-and-white window where your words appear large as you speak, Echo's answers sit beside a line of colour, and Talk, Workers and Settings are one switch at the top. Colour appears only for the answer, the main action, and when Echo needs you.

- Echo has a face again: a glass pearl with eyes. It listens (rings spread with your voice), thinks, speaks, celebrates, says sorry, dozes off with a soft light inside, and follows your pointer. Choose its look in Settings → Companion (Glass, Moon, or Auto, which picks whichever stands out), each shown alive before you choose; "Let it be lively" off makes it calmer. One click on it starts or stops listening; quick clicks and petting only play with it.

- Echo's caption is now a small black bar under the menu bar, the island, with the pearl at its left: it shows your words as you speak, the answer a line at a time, what Echo is doing on your Mac with a Stop button, and grows into a card with Cancel and an action button when it needs your OK. It has a close button, can no longer get stuck on screen, and stays out of the way of menus and alerts.

- Echo points with its light. A small firefly leaves the pearl, flies to the thing it means and circles it; it dives for a click, carries a drag, hops along as it types and rides a scroll, then comes home. You can pick the light up and drop it on something to say "this one"; in lessons it waits on each step until you've done it; it shows the way through menus; and its colour tells you whether Echo is showing (white), acting (colour) or asking (amber).

- In the Mac app, Echo now listens one way for everything. Holding Space or Control + Option always works at once, even in hands-free and while Echo is talking; you can talk over it without losing what you said; the ring says "Listening" only when the microphone really is on; the microphone (and the orange dot) is on only while Echo is actually listening; it recovers when you connect AirPods or wake the Mac; and if a sentence goes nowhere, Echo tells you why. Apple's on-device speech recognition is used when your Mac has it. The Labs switches for these (app mic, Apple speech, quicker sentence end, gentler interruptions, one reply while busy, conversation window) are gone: this is simply how Echo works now.

- Echo tells your voice from a phone or TV in the room by how loud it is, answers once when two microphones catch the same sentence (push-to-talk wins, with no "didn't catch that"), gives you the full follow-up time from when you start speaking, asks "Was that for me?" instead of silently skipping something it wasn't sure about, and no longer turns near-silence into made-up words.

- Echo no longer gets stuck "busy" after answering two things at once, never talks about which model is answering unless you ask, doesn't start an answer and then start over, shows extra notes in a closed Details block under the answer, answers short remarks sooner, and says a quick line when it's working quietly.

- Lessons no longer jump ahead: Echo moves on only when it sees you do the step (or asks you to say when you're done), waits for the exact thing the step names, starts lessons faster, stops reading its own notes aloud, and a stuck screen read gives up in seconds rather than 20.

- Quitting Echo now really quits it (it asks first if tasks are still running; "Keep working in the background after I quit" is a choice, off by default), and the menu bar shows when Echo is running.

- Echo keeps a second-by-second record of what the Mac app, the window and the server were doing (never what you said or what was on screen), so a slow or stuck moment can be read back afterwards with `npm run timeline -- --since 10m`.

- The companion responds the instant you click it, never looks at your screen just to pick its colour (Auto follows your Mac's light or dark setting), and uses less power while resting. Dropping the light on something tells Echo only that control's own name, never the text inside it.

- Echo waits for you to finish a thought instead of cutting you off after "I just think"; if it isn't sure you were talking to it, it shows "Send anyway" instead of going silent; and in a lesson, saying "done" gets a straight answer about what it sees, with an offer to do the step, or the whole lesson, for you.

- In Excel and Numbers, Echo goes straight to the cell you name, types into it without doubling what's there, and can tell when bold took. Anything Echo types is now always checked exactly.

- Echo works in Excel and Numbers directly instead of clicking and typing in the grid: filling a table takes seconds, values land in the right cells, "undo that" puts them back, replacing more than 20 filled cells asks first, and lessons can see what you typed. macOS asks once whether Echo may control Excel or Numbers.

- When Echo works on your Mac, a small caption appears next to its light saying what the step is ("Clicking Send", "Typing in Subject", "Your turn") and fades after a moment ("Your turn" and "Is this OK?" stay until you act); it never shows what is typed, and you can turn it off in Settings → Companion.

- Echo says "this one" at the moment its light lands on the thing, says where to look while the light is on its way, holds longer on small or crowded targets, and points again if you look elsewhere.

- In lessons, Echo helps a little at a time: it waits, then nudges, then describes where to look, then points, and only then offers to do the step, and it backs off as you get things right. Say "where?" for more help, "show me" to have it done, or "I know this" to hear less.

- Lessons: say "show me" and Echo does the step slowly, telling you what it's about to do and what changed, then offers you a turn. It tells you why a step matters right after you get it, says less as you get the hang of it, and remembers how you did in each app.

- Settings has a new "What happened" page: every time Echo answered, how long you waited and where the time went, with slow ones marked; hover one of Echo's replies and click "…" to see that one.

- In lessons, Echo's hints tell you where to look first ("It's in the toolbar at the top left: the Rectangle button"), and Echo knows when it has actually finished speaking, so it waits for its own words to end before moving, pausing or nudging you.

- Echo can tidy files, find and write notes, check and add reminders, read your calendar, and read or draft mail directly, without clicking around those apps; it always asks before moving anything to the Trash and never sends mail on its own. macOS asks once per app whether Echo may control it.

- Everything that was in Settings → Labs is now simply how Echo works (asking by what an action does, looking at just your window, keeping going while it gets somewhere, checking before it says done, your rules, learned skills, and "catch me up"); Labs is where you turn one off if it misbehaves. Echo no longer rewrites what you said.

- Echo can connect to Adobe XD through a small panel you load once (integrations/xd-bridge): it can read what is in your document, and "run the XD probe" finds out whether XD will let Echo make changes for you.

- When Echo has to look at your screen or check something before answering, it says a quick "Looking." or "One moment." right away instead of leaving you in silence; it starts working out your sentence a moment before you finish it; and it no longer waits most of a second on a local model that never answers.

- Echo shows a small checklist of the Mac permissions it needs the first time you open it (and any time from its menu bar icon, under Permissions…), with what each one is for, whether it is allowed, and one button to allow it.

- "Show me where it is" and "teach me" are now one thing: Echo points at each step, moves on when you've done it, offers help if you pause, and you can say "show me", "skip" or "stop" at any point; the step and a Stop button show above the message box.

- The menu bar icon is now Echo's three bars (it was still the old "e" with rings), and the starting-up screen is black with a white button like the rest of the app.

- Echo no longer answers you with silence when you were clearly talking to it: a sentence said with the key held down, its name, or "there you go" after it asked you to tell it when, always gets a reply, and if it couldn't make sense of the words it asks you to say it again instead of guessing and acting.

- A quiet or clipped "yes" no longer approves a delete, a send or a risky step by itself: Echo asks once more what you're saying yes to.

- In a lesson, "show me where" and "where is it" make the light point at it; Echo only does a step for you when you say "do it for me".

- Echo says a short, specific line before it starts working on something instead of going silent, says things once instead of repeating them when a task reports in, and no longer shows its own internal notes in the chat or flatters you.

- When you say no to something risky, Echo no longer finds another way to do it; sending a file by AirDrop now asks first; and one yes now covers the app's own "are you sure?" (Try Again, Don't Save) instead of asking you twice.

- Echo no longer bounces a clear sentence back with "say that again": when its quick model wrongly decides you weren't talking to it, the main model answers instead.

- Echo remembers what it already did in a long session (uploaded, sent, submitted) instead of forgetting it when the conversation gets long.

- After sending a text, Echo tells you only what it knows ("sent", "went as a green text message", or "not delivered") instead of saying they got it, and can answer "did it go through?" for photos without looking at the screen.

- Echo can add hundreds of rows to a spreadsheet in one go, makes sample data itself in a moment, and only reads a number or address back to you if you actually said it.

- A new conversation log keeps what you said and what Echo answered, with the time of each, on this Mac for 30 days (Settings, "Keep a conversation log"); `npm run transcript -- --since 30m` reads a session back.

- Echo no longer shows "[hand_off]" or "error_during_execution" in the chat, and is told not to think aloud about how it is doing something.

- Echo double-checks what it heard: a second recognizer on your Mac listens to each sentence, and when it clearly heard you better ("Now what's next?" where the first one wrote "Nava snacks"), Echo starts its answer again with the right words and fixes them in the chat. Sentences both agree on are not slowed down. Settings, "Double-check what I heard".

- Both recognizers are now told what the conversation is about: the names Echo has just been saying (a folder, a site) and the words of the app you're in ("pivot table" in Excel), so they are heard right more often.

- Talking no longer covers the conversation: your words appear as the next bubble while you say them, the companion stays small beside "Listening", and the message box tells you what the key does. The large companion is on the empty Home screen only.

- The menu bar menu shows what Echo is doing at the top, puts Listening, Hands-free and Show Caption first with ticks, and has a Settings… item; updates, permissions, open at login, keep working after quit and the summon shortcut moved into Settings.

- Settings is much shorter: five sections and 30 plain rows instead of 73. Everything removed now just works at its usual setting; the word-list editors, Brief voice and the ambient music are gone; "What happened" and the help report moved to the ··· menu.

- The pearl has more expressions, with the same face: its eyes go along the work while Echo is busy on your Mac, it nods when it has heard you, tilts its head when it has asked you something, winks when it corrects what it heard, looks quietly pleased when you say yes (instead of hopping every time), and concentrates harder on a long think.

- After Echo has sat quiet for a while (an hour or two, the Mac asleep, the sound output changed), it used to answer in text with no voice. It now opens the sound output afresh before the first line after a quiet stretch, and each line it plays is logged with the state of the sound system so a silent one can be traced.

- Echo no longer reads a list of sources aloud after looking something up: they are shown under the answer.

- When a file doesn't attach to a text, Echo now says the words went but the file didn't, and suggests AirDrop or email, instead of showing "Sent".

- Echo no longer tells you it can't do something it can: when its quick model is about to refuse, the main model takes the turn instead. It also no longer reads steps out as a numbered list.

- Ask Echo to explain something on your screen and it now shows you: it points at one part at a time, says one sentence about it, and lists the parts in the chat. Say "next", "back", "again" or "stop".

- Ask Echo to write a small file (a web page, a note, a list) and it now appears on your Desktop in a second and opens, instead of Echo typing it into an editor; "make it look better" changes it in place, and "undo that" puts the old version back.

- A job that changes one of your files now asks once, saying everything it needs ("replace hello.html on your Desktop and open it to check"), instead of again for each step; and Echo mentions a waiting approval once, with one reminder after three minutes, rather than in every reply.

- Stopping a reply yourself (Stop or Escape) no longer shows "That reply was cut short".

All of the above needs a rebuild of the Mac app (npm run build-app).

- A new icon and mark, "Fade": three round-ended bars from a shared left edge on black. They read as an E and as an echo: what you said (white), it fading (grey), and the answer coming back (a bar of colour, glowing). It replaces the sunset drop on the Mac app, in the Dock and Finder, as the page's icon in a browser, and on the app's "starting up" screen, and it's drawn for every size from 16 to 1024 pixels. Needs a rebuild of the Mac app (npm run build-app).

- Fixes from a second review, of the fixes above. "What did I miss?" is only taken as that when it's the whole sentence, so "what's new in iOS 26?" or "any updates to install?" go to the assistant as before. Forgetting a rule or finding a skill by a few of its words works again ("forget never save"). When Apple's speech model is slow and Whisper isn't installed, the sentence comes back blank instead of as an error. A name in front of what you said is only dropped when the live listener heard the sentence without it (or it's a first and last name), so "Monday: call the dentist" and "Mom: running late" stay whole. Saying "okay" twice while Echo is busy is one "okay". A task that can't start again because of the daily limit no longer logs the instruction as given. Needs a rebuild of the Mac app (npm run build-app).

- "What did I miss?" (Settings → Updates → Labs, "Catch me up", off until you switch it on). Back at your Mac after a while, ask "what did I miss?", "catch me up", "any updates?" or just say "I'm back", and Echo tells you at once, without waiting on the model, what happened since you last talked: the tasks that finished (by name) or didn't, what's waiting for your OK or still going, how many updates came in, and a job on the Mac that's still open ("say carry on to pick it up"). If nothing happened, it says so. The assistant hears what you were told, so you can go straight into any of it.

- Clearer words. When you take over with your own mouse or keyboard, Echo now says "Okay, I've stopped." ("Okay, go ahead" sounded like permission for something). When you stop Echo yourself (saying stop, Esc, the window's Stop button, turning computer use off), it no longer starts a reply just to tell you it stopped: the assistant hears about it with your next message. A name Whisper sometimes puts in front of what you said, as in a meeting transcript ("Gino: And you'll do it again."), is no longer taken as part of your words; a dictated "Note:" or "Subject:" stays.

- Fixes from a review of the October 2 groundwork. Eleven of the assistant's tool descriptions had "this" turned into a stray "d" when the tools moved out of the dispatcher ("a website that runs on d Mac", "what's d error?"); they read as written again. The "Looking" chip shows again while Echo looks at your screen through the Mac app's own line. Esc with a dialog open over Settings closes just the dialog (it closed both, and stopped Echo's reply). A fresh install picks its accent from the Mac's region even when the Mac app starts Echo (it always picked US English then). A web address for a folder of Echo's page no longer takes the server down. The Mac app's own line to Echo reconnects quickly again after a restart. A file write that fails part way (a full disk) leaves no half-written copy behind. The scorecard counts days where you are, so a late evening isn't two days. Needs a rebuild of the Mac app (npm run build-app).

- Fixes from a review of the newer agent features. One reply when you talk while Echo is busy: a sentence that asks for more than one already waiting ("check that", then "check that and the Jira board") is no longer dropped as a repeat, while the same ask in other words still is; "stop" now cancels what was waiting too, as Echo's "say stop to cancel" promises; a picture sent while sentences wait goes in after them, in order; and the "still working" lines can't be said for a conversation that was already replaced. Rules and skills: two rules that share most of a sentence but not its subject ("keep the footer at the bottom", "keep the header at the bottom") stay two, and so do two jobs for different people; the opposite of a rule still replaces it. A job on the Mac untouched for two hours is cleared while Echo runs (not only at restart), and checking some other goal no longer finishes the job on file or learns a skill from it. Spending limits: going on with a task that stopped at its limit gives it the same limit again (it used to run on with no limit), and starting a task again respects the daily limit. The report for whoever helps you leaves out listening's log lines and anything in quotes, and saves exactly the report you were shown. Reading an app's menus for its shortcuts can't run past its time limit on a very big menu. Needs a rebuild of the Mac app (npm run build-app).

- Listening fixes from a review of the new voice features. With Apple's speech on, a short sentence said right after Echo starts listening is no longer lost (the audio that came while the model was getting ready used to be dropped), live words stop once the sentence is being finished, a sentence that isn't sent (too short, not for Echo, a wake-word check) no longer leaves its words to mix into the next one, and if Apple's model is slow to finish, Whisper takes the sentence after 2 s instead of Echo waiting. With "Lower her voice when you start talking" on, her voice always comes back up (it could stay quiet for the rest of a reply), and a cough no longer cuts her off just because the wait was shorter than your pause setting. With a long pause set (over 3 s), the smart sentence end no longer cuts you off sooner than your setting. Typing into an address bar no longer counts as wrong when the bar fills in the rest of the address itself. A line break typed in Numbers or Excel goes to the next row (Shift+Return went up a row). Hold-to-talk uses the app's mic only once the mic is allowed. `npm run golden` no longer writes its test settings into Echo's own settings. Needs a rebuild of the Mac app (npm run build-app).

- "Can you hear me?" always gets an answer (with "One reply when you talk while Echo is busy" on). On Oct 2 you asked "can you hear me?" and "what's happening?" about ten times while Echo was busy and silent. Now, while a reply is under way, a question about Echo itself is answered at once, with no model call: what it's still on, for how long, what it's waiting for (the model, a retry, your plan's limit, a step in an app) and how many of your messages are next. Echo also now knows why a reply is slow: when the model is busy or rate limited and the request is being tried again, it says so once ("The model's busy right now, so I'm trying again"), and when your Claude plan reaches its usage limit it says so at once, with when it resets. Both are in the logs too, so slow evenings can be explained afterwards.

- One reply when you talk while Echo is busy (Settings → Updates → Labs, "One reply when you talk while Echo is busy", off until you switch it on). On Oct 2, replies took up to 78 s to start, and everything said meanwhile became its own turn: replies came one to three turns late, and "Can you check that for me?" said three times was answered three times. Now what you say while a reply is under way waits and joins together for one reply when the current one ends, and a repeat isn't added. While you wait, Echo says so: "Still working on that" after 10 s, after 45 s that it's slow (and how much is waiting) and that "stop" cancels it, and if no answer comes at all it says so, and asks you to say it again rather than going quiet. Each message's log now also records when the assistant actually read it, so a slow model can be told from Echo's own queue.

- When a keyboard shortcut changes nothing, Echo now finds out why from the app's own menus. On Oct 2, ⌘T and ⌘N did nothing in the Claude app and Echo couldn't tell a shortcut the app doesn't have from one that failed. Now: if no menu lists it, Echo is told so, with the shortcuts the menus do list ("File > New Chat (⌘N)"), and uses one of those or the menu item; if it is a menu item's shortcut, Echo looks at the screen before trying that menu item (a shortcut can work out of sight, so it's never done twice blindly). Needs a rebuild of the Mac app (npm run build-app).

- A line break Echo types no longer sends a message. Echo typed line breaks as Return, and in a chat box (Claude, Slack, Messages) Return sends: on Oct 2 a dictated message with a numbered list went out as several messages, the first cut off at "Before I do:". A line break is now Shift+Return, a new line in chat boxes and ordinary editors alike; in a terminal it's still Return. Needs a rebuild of the Mac app (npm run build-app).

- A report for whoever helps you with Echo (Settings → Privacy & safety → "Preview & save…"): Echo's version, the Mac and Node versions, which new features are on, last week's scorecard numbers and the recent errors from the log, with secrets blacked out, your home folder as ~ and nothing anyone said in it. You see all of it first; it's saved to your Downloads folder (and shown in Finder), and it's never sent anywhere: you choose who gets it.

- `npm run release` now has a gate: before anything is bumped or built, the tests and the type check run in a clean environment (as for self-improve reviews) and every golden task runs three times; a failure, or a "done" that wasn't, stops the release with nothing changed. `--no-gate` skips it (not for real releases).

- Leaner context for the assistant, so long sessions cost less and stay quick. Tool results go to the model as compact JSON (about a fifth smaller than before; every result stays in the conversation's context and was paid for again on every later call). With computer use off, the tools that act on the screen aren't offered at all (44 tools instead of 58, about 3k tokens less on every call); guide, lessons and looking at the screen stay.

- Spending limits (Settings → Account & AI → Usage, both off unless you set them). "Limit per task": a worker task stops when it has cost that much, the log says why, and Echo tells you and asks whether to go on (continuing it picks up where it stopped). "Daily limit": once today's total reaches it, no new worker task starts (Echo says so and where to raise it); the conversation itself and quick things still work.

- Skills Echo learns (Settings → Updates → Labs, "Skills Echo learns", off until you switch it on; it needs "Check before saying done" too). When a job in an app is checked done, Echo keeps how it did it. When a job like it (the same thing, in the same app) has worked twice, that way becomes a skill: the shorter of the ways that worked, with a version. Each session sees the skills listed by app, and before a job like one it fetches the steps and follows them, checking each one, instead of working it out again. What was typed is never kept in a skill, only where. Settings → General → "Skills Echo has learned" lists them, each with its steps (hover), version and a Remove button.

- Rules you give Echo (Settings → Updates → Labs, "Rules you give Echo", off until you switch it on). When you tell Echo how you always want something done, or correct a habit of its own ("never save unless I ask", "keep the footer at the bottom in XD", "stop opening new tabs"), it keeps it as a rule in your words, for every app or just one, and follows it every time, in every session, over its own defaults. The same rule said again, or its opposite, replaces the old one. Settings → General → "Rules Echo follows" lists them, each with where it applies, since when, and a Remove button.

- A job on the Mac survives a fresh session or a restart (with "Check before saying done" on). Once Echo has said what done means, the job is written down as it goes (the goal, its points, the app, how many steps, the last few things done) in data/job.json. When the conversation moves to a fresh session to stay fast, or Echo restarts, the job comes along: Echo knows where it got to, looks at the screen first, and carries on if you do. It's cleared when the job is checked done, replaced by a new one, or two hours old.

- Echo checks before saying it's done (Settings → Updates → Labs, "Check before saying done", off until you switch it on). For a job on the Mac with several steps (a layout, a form, a document), Echo first says what done means: the goal and the points it must meet, said back to you in a sentence. Before it tells you it's done, a separate check looks at the screen and judges each point, without ever seeing what Echo claimed, and it's told to be skeptical (for design work: alignment, spacing, contrast, nothing overlapping or cut off). Echo says done only when every point passes; otherwise it keeps working on what failed, or tells you honestly what's left. Each check is one model call, counted in your usage.

- No more "keep going?" every 25 steps (Settings → Updates → Labs, "Keep going while it gets somewhere", off until you switch it on). Working on the Mac, Echo carries on while each step gets somewhere, says one short line of progress every 20 steps, and stops when it's stuck: most of its last 8 steps did nothing, or the same thing failed 3 times in a row. Then it says what's in the way and asks, instead of trying again. A firm limit stays: 120 steps or 20 minutes for one request. (Between Sep 24 and Oct 2 you said "keep going" 16 times, every one because of the old limit.)

- Echo can look at just the window you're in (Settings → Updates → Labs, "Look at just the window you are in", off until you switch it on). A look at the screen is cropped to the window you're working in (with a small margin), so the picture is sharper where it matters and smaller to send; clicks found by eye, numbered marks and the grid line up with it. Echo can still ask for the whole screen for the menu bar, the Dock or another window. Needs a rebuild of the Mac app (npm run build-app).

- New `npm run golden`: every computer-use task in the eval suite (64, on the simulated Mac) run three times; a task passes only when all three runs succeed (or, for the four that can't be done, when Echo says so instead of claiming it). Each run is kept in data/golden/results.jsonl, and the scorecard's "golden tasks passing all 3 runs" reads it. Today: 64 of 64, no false "done" in 192 runs. Runs on your own Mac with real apps come next.

- With "Stricter checks on what Echo did" on (Labs), typing is checked exactly: replacing a field's text, it must hold exactly that (not just contain it somewhere); adding to it, it must have grown by the text (text that was already there no longer counts as typed); a long text must be there whole (only its last 40 characters used to be checked). And a checkbox or switch is never clicked a second time to make sure (if its first press landed late, the second switched it straight back); it gets a little longer to show its new state instead. Needs a rebuild of the Mac app (npm run build-app).

- Stricter checks on what Echo did on the Mac (Settings → Updates → Labs, off until you switch it on). A step only counts as done when the right thing changed: a checkbox or switch must actually switch, a field must take the cursor, and a button must do more than take the keyboard focus (on Oct 1, "done" clicks that only moved the focus were part of why Echo claimed changes in XD it hadn't made). When a click changed something but not that, Echo is told it may still have worked out of sight (on a drawing canvas) and to look before trying again, never to click twice blindly. And a step's "this should appear next" check now looks before the action too, so something already on screen no longer proves the step worked.

- Gentler interruptions (Settings → Updates → Labs, off until you switch it on). When you start talking over Echo and the Mac app's mic is listening, her voice drops at once and stops only when your words come through; a cough, a laugh, a door or an "um" leaves her be, and she carries on at full volume where she was. With no live words to go by, she stops after a moment, as before. (The browser's own voice can't be lowered, so it still stops at once.)

- Echo now measures when you actually hear it. The window tells the server the moment Echo's voice becomes audible for each turn (after the voice is made and played, the speakers' delay included), and it's logged as the turn's first sound; the scorecard's "first sound after you stop" uses it (it used to stop at the first sentence ready to speak).

- Echo can answer sooner after a finished sentence (Settings → Updates → Labs, "Answer sooner after a finished sentence", off until you switch it on). When the Mac app's mic is listening (while Echo works on the Mac, or waits for your answer), the words heard so far decide how long a pause ends your turn: about 0.7 s after a sentence that sounds finished instead of the usual 1.3 s, and longer after one that stops on "and", "the", "to", "um" or a comma, so stopping to think isn't taken as the end. Needs a rebuild of the Mac app (npm run build-app).

- Push-to-talk through the Mac app's mic (Settings → Updates → Labs, off until you switch it on). In the Mac app, holding Space or clicking the mic records with the app's own mic, the way Control + Option already did: Apple's echo cancellation, so Echo's own voice and the speakers stay out of it, and Apple's speech recognition when that's on too. One mic for every way of talking in the app; the window's mic is kept for hands-free and for Echo in a browser tab. Needs a rebuild of the Mac app (npm run build-app).

- Apple's speech recognition in the Mac app (Settings → Updates → Labs, off until you switch it on; macOS 26 or later). The app's own mic transcribes each sentence with Apple's on-device dictation model while you say it, so the text is ready about 0.05–0.15 s after you stop instead of the 1.4 s Whisper takes; the words show live as you talk. Your contacts', projects' and apps' names are given to it, so "Mira" comes out as Mira rather than Rita. Nothing leaves the Mac. When it can't run (an older macOS, the model not on the Mac yet) Whisper transcribes as before, and a Mac without Whisper can now use the app's mic with it. Needs a rebuild of the Mac app (npm run build-app).

- Settings → Updates → Labs lists the new ways of working that are still behind a switch (the conversation window, asking by what an action does, names as hints, Apple's speech recognition, the Messages API), each one with a switch; one set where Echo was started shows as fixed.

- New `npm run scorecard` (scripts/scorecard.ts): the 15 numbers every stage is judged by, computed from Echo's own logs for any stretch of days (the last 7 by default, or `--from`/`--to`): speech set aside that was meant for Echo, background speech that triggered something, how much of what you say is repeating, approving or pushing on, Echo's own interruptions, speed from when you stop talking, approval prompts a day, actions that changed nothing, disputed "done", "keep going", cost per spoken turn, context size, double hearing, and golden tasks once they exist. `--save` keeps each run, so weeks can be compared.

- A crash can't corrupt Echo's state any more. Settings, the conversation's state, tasks, costs, vocabulary, projects, contact nicknames, the voice budget and the update state are written to a temporary file and swapped in whole, so a crash or a full disk never leaves half a file; the copy it replaced is kept (as .bak), and a file that won't read is taken from that copy instead of starting over. Secrets (the PIN, the pairing code, the Mac app's token) are written the same way, with no copy kept.

- Echo no longer assumes who you are. A fresh install picks its accent from the Mac's region (India: Indian English, the US: American English, anywhere else: plain English), and setup still asks; an install from before that never chose one keeps Indian English, as before. The old correction pass only mentions an Indian accent when that's the accent chosen. Settings are read from disk only when the file changes (they were read and parsed dozens of times a turn); a hand edit still takes effect at once.

- The assistant's model sits behind one interface (`lib/brain/provider.ts`). Nothing changes by default: the conversation still runs on the Claude Agent SDK with your sign-in, with exactly the same options. New, behind the `messages` flag (off): the conversation can talk to the Messages API directly, with Echo running its own tool loop (needs `ANTHROPIC_API_KEY` in the .env file). It's the path to faster first words and cheaper turns, and to other model providers later. Coding workers stay on the Agent SDK.

- Under the hood, no change in behavior: the window's page (`public/app.js`, 3,135 lines, now 2,211) is split into views in `public/ui/`: the conversation's cards (`chat.js`), the Workers tab and usage (`tasks.js`), self-improve (`selfimprove.js`), updates (`updates.js`), the message box (`composer.js`), the dialog (`modal.js`), the WebSocket (`socket.js`), saved choices (`prefs.js`) and small helpers (`dom.js`). Listening, speaking, the orb and Settings stay in app.js for now (Stage 4 rebuilds listening and speaking in the Mac app). Tests that read the page's source use `pageSource()` in test/helpers.js.

- Under the hood, no change in behavior: `server.js` (1,158 lines, now 445) only puts Echo together and starts it. Listening, from a clip or the browser's recognizer to a turn, is in `lib/server/speech.js`; the rest of the HTTP API in `lib/server/routes.js` (one table of routes instead of a long switch); the page's WebSocket messages in `lib/server/window.js`; and the shared HTTP helpers in `lib/server/http.js`. Tests that check how the server is wired read all of these together (`serverSource()` in test/helpers.js), so they keep working when code moves between them.

- Under the hood, no change in behavior: computer use (`lib/computer.js`, 1,836 lines, now 1,281) is split by job. What you say during a run (stop, pause, a new instruction) is in `lib/agent/speech.js`, key names in `lib/agent/keys.js`, the word-based risk rules in `lib/agent/risk.js`, the run limits in `lib/agent/limits.js`, and the assistant's computer-use tools and instructions in `lib/tools/computer.js`. `lib/computer.js` keeps the driving session itself and still exports everything it did.

- Under the hood, no change in behavior: the assistant's tools moved out of `lib/dispatcher.js` (2,016 lines, now 1,380) into `lib/tools/`: `core.js` (tasks, projects, research, approvals, memory, vocabulary), `screen.js` (looking and pointing), `quick.js` (messages, calendar, apps, files, media), `projects.js` (project and research folders, task summaries) and `result.js`. The dispatcher still exports what it did, so nothing that imports it changes.

- The Mac app has its own line to Echo's server. Requests to act, look, point or check the screen used to reach the app only through the web page in its window (server, then page, then app), so a page that was reloading or busy left Echo without its hands: steps timed out, "the Mac app isn't answering", a guide's pill stayed on screen. Now the app keeps a direct connection and gets them itself (answers go back as before); the page only relays for an older app. While the direct line is up, requests go only there, so nothing runs twice. It's protected by a token only Echo's own data folder has (data/self/body-token, readable by you only), so no other program can pose as Echo's hands. Needs a rebuild of the Mac app (npm run build-app).

- Turns no longer get mixed up when you talk while Echo is still answering. What you say mid-reply is its own turn, queued behind the one under way: each keeps its own reply, timing and id in the logs (before, the second overwrote the first, so its reply was recorded under the wrong request), Echo stays busy until both are done (it used to go idle while the second was still being answered), and the model isn't switched under the reply still being written. When the assistant's session is replaced (a rotation, a reload), anything you said that it hadn't read yet goes along to the new one instead of being dropped; starting a new conversation still clears everything.

- Under the hood, no change in behavior: the server can be started from a test (`start({ port: 0, boot: false })` in server.js, which now exports its parts) instead of starting the moment it's loaded, so a whole turn can be tested end to end: a sentence over the page's WebSocket, through the real pipeline to a stand-in model, and back as the chat and voice events. `node server.js` and the supervisor start it exactly as before.

- Fewer interruptions (with the `policy` flag on). A background update ("task 5 finished") no longer cuts in right after Echo speaks with an "Oh, and…": it waits for your next turn and gets one short mention after the answer, or, if nobody says anything for two minutes, all of them come as one sentence. When several tasks need your OK at once, Echo asks once ("Two tasks need you: …. Okay to both?") instead of a spoken question each; every one still has its own card, and only what you clearly agree to is approved. A plain local commit in the task's own folder no longer asks (in 773 approval requests it was never turned down); amending, skipping hooks, pushing or anything else risky still does. Approvals and spoken updates were about a fifth of everything Echo said in the last week.

- Pointer safety, from a real lesson (Oct 2). Asked to point at the Apple menu, Echo pointed at the Passwords icon in the menu bar instead (its menu bar search only looked at the status icons on the right, and that icon's name mentions Apple), and clicking it opened Passwords. Now the menu bar search looks at the Apple menu and the front app's own menus first, and never at the Passwords app, Keychain Access or their menu bar icon; Echo also refuses to point at, guide to or act on them (if the Mac app ever reports one, the guide stops and Echo says in words where the step really is). When the Mac app isn't answering, Echo says so instead of telling you to rebuild it. The guide pill's Stop button hides it at once, and the pill goes by itself if a guide falls silent for 75 seconds. Needs a rebuild of the Mac app (npm run build-app).

- Confirmation cards that hold (with the `policy` flag on). While a card waits for your answer, Echo does nothing else on the Mac (it used to carry on with other steps). When you say yes or click Allow, the step goes to exactly what you approved: if the screen changed while the card waited (on Oct 1 two allowed clicks landed on a different panel), nothing is done and Echo says so. Moving on without answering ("actually, make the title bigger") drops the card instead of holding everything up; a yes or a no still answers it. Read-backs are only for what you dictated (a phone number you said, an address): a color or size Echo picked itself goes straight in.

- Approvals, Stage 2 (behind the `policy` feature flag, off until switched on): Echo asks by what an action does, not by words in a button's name, in four tiers. Undoable edits in the open document never ask: a field called "Apply Corner Radius", a "Finish" checkbox or canvas text with "finish" in it is an edit, not a form (9 of the confirmation cards in the Oct 1 Adobe XD session were these). Saving (⌘S, Save, Save As), closing or quitting, and deleting ask unless your own words just said exactly that ("save it", "quit XD", "delete the screenshot"); before, ⌘S saved without asking. Sending, posting, submitting a form, buying, accounts, System Settings, installing and the Terminal always ask, even when you said to. Passwords, codes, card numbers and moving money are never Echo's to do. A spoken "send it to Sam" no longer skips the question: sending always asks.

- You can see the conversation window (with Stage 1 listening on). Under the orb, a small ring and a few words show when Echo is listening without "Echo": "Listening · 6 s" after it speaks, "Your turn · 12 s" after a question (the ring empties as the time runs out), "Listening while I work" and "Talk mode" (a slow breath instead of a countdown). The caption bar shows the same words when Echo's window isn't in front. A soft chime plays as the window opens and a lower one as it closes on its own or after "thanks". It only shows while the mic really is listening, and the page's mic now follows the same window as the server (8 and 15 seconds, Talk mode, while Echo works), so what you see is what Echo does. Reduced motion stops the animation.

- Listening, Stage 1 (behind the `session` feature flag, off until switched on): a conversation window decides how Echo listens, the way Alexa, Google and Gemini do. While Echo works for you, for 8 seconds after it finishes speaking (15 after a question), and in Talk mode ("let's talk": until 30 seconds pass with nothing said to Echo, 30 minutes at most), what you say goes to Echo with the conversation in view; no "Echo" needed. "Thanks", "that's all", "goodbye" close the window; push-to-talk or "Hey Echo" open it again. Inside the window, a sentence is left alone only on evidence (another language, talk about some other device, or a video playing and the sentence isn't shaped like something said to Echo), and then it shows as a "Was that for me?" chip; when Echo isn't sure, it gets the sentence with a note and may simply stay quiet. While Echo works on the Mac, a correction is done at the next step instead of being kept back, and "stop" still cuts in. "That was for you" sends the last sentence it set aside. Push-to-talk can no longer be mistaken for Echo's own voice. On every sentence from Sep 24 to Oct 2 (scripts/replay.ts), sentences meant for Echo that it would leave alone drop from 18% to 0.7% (44% to 2% while it worked on the Mac), and noise taken as a request from 35% to 0%.

- New `node scripts/replay.ts`: how well Echo decides what's meant for it, measured on every sentence it has ever heard. Each one is rebuilt with its situation (which mic, whether Echo was working on the Mac, the conversation just before), run through the real decision, and scored against a label taken from the evidence in the logs, so nobody has to label recordings: said again within two minutes and then heard means it was for Echo; a sound token like "*sad*" means it wasn't; answered and carried on means it was. It reports how many sentences meant for Echo it would leave alone, how many it would take that weren't meant for it, by mic and while working, and how closely the replay reproduces what really happened. `--save` keeps the numbers as a baseline and `--check` fails if a change makes them worse; `ECHO_FLAG_<NAME>=1` tries a feature flag before it ships. First run on Sep 24 to Oct 2: 18% of sentences meant for Echo left alone (44% while it worked on the Mac, under 1% with push-to-talk).

- What you say now reaches Echo exactly as it was heard. The automatic correction is gone: learned mishearings no longer rewrite your words, and no correction model reworks every sentence (it once deleted words, swapped a name for yours, and added up to a second before Echo answered). Instead Echo works the way Siri, Alexa and Google Assistant do: the recognizer is given your names (projects, contacts, apps, words you taught it) so it leans toward them, and when a word sounds like one of your names ("Ria" for Mira, "cloud" for Claude), the assistant gets a note that it may be that name and decides from the conversation, asking you when it matters. Letters you spell out one by one still count as exactly what you meant. The "Smart correction" switch is gone from Settings; `ECHO_FLAG_HINTS=0` brings the old way back.

- Fixes from a real test (Oct 2):
  - Brief voice now really is brief. The model often ignored the instruction and spoke whole replies, so the limit is now enforced: at most the first two sentences are said, plus a closing question if the reply ends with one; a "Sources:" list is never said. A 404-character reply now speaks 120.
  - Echo learns that it mishears a word only when you've just told it so ("I said…", "it's called…"), never on its own guess, and a newer correction replaces its opposite instead of making two names flip back and forth forever. A guessed correction plus its opposite had made "Silver Lake" and "Silver Leaf" swap every time either was said.
  - "Open Chrome" opens Google Chrome (and "Word" Microsoft Word): a short app name opens the one installed app it clearly means, instead of failing and trying another browser.

- Brief voice (beta), in Settings → Voice, off by default. Echo says only the key point or its question out loud, in a sentence or two; the details (steps, lists, numbers) appear in the chat but aren't spoken. The same reply writes both, so the voice starts as fast as before and no extra model is called. It saves premium-voice credits and time. Read-backs before sending or confirming are always said in full, and "read me all of it" still reads everything. Each turn logs how many characters were spoken and how many were shown, so the saving can be measured.

- Under the hood, no change in behavior: what happens to a sentence after it's transcribed (the "Hey Echo" strip, Echo hearing its own voice, and the "was that for me?" checks while Echo works on the Mac, in the answer window and in the follow-up window) moved out of `server.js` into one function, `lib/pipeline/utterance.ts`, so it can be tested directly and every past sentence can be replayed through it. Its tests pin today's behavior, including the known problem Stage 1 of the core plan fixes: sentences said to Echo while it works on the Mac are set aside, because that check never sees the conversation.

- Every turn now has one id from the moment it arrives (a sentence, a typed message or a task event), carried through every log: what was heard (`stt-log.jsonl`), each model call and the turn's timing (`dispatcher-timing.jsonl`), and every action on the Mac (`computer-log.jsonl`). A new `data/events.jsonl` records each turn's milestones (started, first spoken word, ended), so how long you waited can be measured turn by turn. `node scripts/trace.ts --last 3` prints the last three turns' whole story from every log; `node scripts/trace.ts <id>` prints one.

- Groundwork for the core rebuild (no change to how Echo behaves). New modules can be written in TypeScript (`tsconfig.json`, strict); Node runs them directly, with no build step, and `npm run check` type-checks both the TypeScript and the older JavaScript. Echo now needs Node.js 22.18 or newer: the launcher and installers check for it, and an update that needs a newer Node.js than the Mac has is turned down with a message saying how to fix it, instead of failing to start. Core changes ship behind feature flags (`lib/flags.ts`, `settings.core`, or `ECHO_FLAG_<NAME>=1` to try one), off until they've proven themselves. Design decisions are recorded in `docs/adr/`.

- A premium voice that's free first, with Kokoro as the backup. Add an ElevenLabs or Cartesia key to `.env` (Cartesia is new), pick it in Settings → Voice, and Echo speaks with it while its free credits last, then with a Kokoro voice you choose (Backup voice) until they're back, then the premium voice again. It stops before the free (or plan) limit, so it never runs up a bill, even on an account that allows usage-based billing. Settings shows how many free credits are left and when they reset, or why the backup is speaking and until when, and the assistant mentions it once when the voice switches and once when it's back. A premium sentence that fails or takes longer than 4 seconds is said by Kokoro instead (it used to fall back to the browser's robotic voice), and three failures in a row rest the premium voice for 5 minutes. New `scripts/voice-bench.js` compares the voices on this Mac: how long until each sentence is ready, and with `--listen`, how natural each one sounds to you, rated blind. Kokoro takes 2.3 s per sentence here. See docs/premium-voice.md.

- Echo can now measure how well it hears you, on your own voice. With Settings → Privacy & safety → "Keep voice recordings on this Mac" on (the default in the developer copy only), every sentence you say is kept on this Mac for 30 days (at most 3,000 clips, never sent anywhere), including the ones Echo set aside as not meant for it and the ones that came out blank. Every line about a sentence in `data/stt-log.jsonl` carries its recording's id, and sentences that used to vanish without a trace (no words came out, just "Hey Echo") are now logged too. `node scripts/listen-review.js` plays them back and asks whether each was meant for Echo and what you actually said. `node scripts/listen-report.js` then shows how many sentences meant for Echo never reached it, how many not meant for it were answered, the word error rate (for what Echo used, Whisper alone and the live preview), how long hearing took, and how often a sentence went through twice. `--export` writes the labelled clips for `scripts/stt-bench.js`, so speech engines can be compared on your voice. Nothing about how Echo listens changes yet. See docs/listening-measure.md.

- The companion orb has a personality. It has eyes now: they blink every few seconds, look where it's about to go (and at the button it's showing you), watch your mouse while it listens or waits for your yes, glance up and away while it thinks, and look around now and then. They smile (^ ^) when something worked, one goes flat when it couldn't do something, they widen when you talk over Echo, and after three quiet minutes it dozes off until something happens. It stretches as it flies and squashes when it lands, nods when you pass a lesson step, and bursts into stars when you finish a lesson. Resting, it still blinks at almost no CPU (Core Animation draws the eyes). Settings → Companion orb → Eyes turns them off. Reduced motion keeps the blinks and expressions and drops the bouncing. Pictures: docs/companion-personality.md. Needs a rebuild of the Mac app (npm run build-app).

- Lessons no longer go silent when Echo can't see the screen. Reading the screen's text (Apple Vision) took 38 seconds on macOS 27, longer than Echo waits, and a lesson that fell back to it (apps like Adobe XD) would have hung and stayed quiet. Now a text read slower than 2.5 seconds, or failing, is switched off for the rest of the lesson, and no request to the Mac app can hold a lesson's check up for more than 3 seconds. While Echo can't see, a step can't pass, the "Still with me?" check-in still comes, and after a few tries Echo says "I can't see your screen right now, so I can't check this step. Say next when you've done it." (the assistant hears it too). A step done while Echo couldn't see counts as soon as it can see again. Logged as `screen_text_off` in `data/lesson-log.jsonl`.

- Lessons fixed after the first real one (Adobe XD, Oct 1), where step 1 never passed in 12 minutes:
  - A step that checks for a label now sees one that's already on screen (it used to count only a label that appeared during a 300 ms wait, so the drawn rectangle never counted). When Accessibility finds nothing, as in canvas apps, Echo reads the screen's text at most every 3 seconds.
  - "Alright, I did", "seems like I did", "I got it, now what next?" and "what's next?" mean "check now", answered from the screen ("Not yet. I don't see it on screen."), instead of going to the model as a question.
  - A question mid-lesson no longer stops the watching: a step you finish while Echo answers still passes, and the lesson speaks once the answer is over.
  - Check-ins ask ("Still with me?" at 20 s; the hint and "Want me to show you?" at 45 s), and the 2-minute pause is said out loud. At 45 s stuck or 3 misses, the assistant looks at the screen and can rewrite a step that can't work.
  - New lesson_control tool: the assistant can stop, pause, resume or skip, or replace the current and later steps.
  - A drag is one step (from and to), so drawing a shape is no longer split into a click that can't draw anything.
  - Lessons, and questions like "what do you think?", always go to the main model (the quick model answered 19 of 40 turns in that lesson and guessed which step you were on).
  - A reply during a lesson counts as meant for Echo.
- The same sentence heard by two mics at once (hands-free plus the Mac app's push-to-talk shortcut) goes through once. On Oct 1 nearly every sentence was answered twice.
- Speech correction knows the names of the apps installed on this Mac (Adobe XD was heard as "auto-biopsy").

- Lessons in any app. Say "teach me to turn on dark mode" (or anything else) and Echo writes a short lesson from what it knows and what's on your screen, then points at each step, says it, and waits until it sees you've done it before moving on. It never clicks for you. It checks the screen, not your word: the right app in front, a window or menu opening, a switch turned on, a tab selected, a slider near a value, text in a field, something closing. It corrects near-misses ("That's Reminders. We want Notes.", "Almost. It says Cofee. Try Coffee.", "That's 55. We want about 70."), re-points if you go quiet, and handles "repeat", "show me", "next", "back", "pause", "undo", "I did it" and "stop" instantly, with no model call. Anything else you ask mid-lesson gets a short answer and the lesson carries on. A lesson never starts with a step whose button isn't on screen, and a step can't pass on something that was already true before you did anything. Each lesson is logged in `data/lesson-log.jsonl` (steps passed and how long they took, hints, questions, the ending), so lessons can be measured. Excel cell lessons still need the Excel adapter. Needs a rebuild of the Mac app (npm run build-app).

- New `node scripts/outcome-report.js`: did computer use actually do what you asked? A drive is a session that normally ends idle or when you say stop, so how a run ended said nothing about success (and `computer-report.js` showed a misleading "done 0%"). Now each request is judged from evidence: whether its last step was confirmed on screen, whether a step failed or was refused, whether you took over or said no to a confirmation, whether Echo said it couldn't do it, and what you said next ("it's not moved", the same request again, or "thanks"). It prints how many worked, why the rest didn't, Echo's working time apart from time spent waiting on your confirmations, and a line per app. `--review` asks you "worked? y/n" for the unclear ones and saves your answers in `data/outcome-labels.json`; they take precedence and show how often the automatic judgement is right. On Sept 30 to Oct 1, 9 of the 13 requests where Echo acted worked. Nothing runs live: it only reads the logs. `computer-report.js` no longer shows the "done" column and points to the new report.

- The quick model no longer starts or steers work. Anything that could start, follow up on or stop a task, project, research or self-improvement, or answer an approval, now goes to the main model, and so does a short "yes", "ok" or "no" right after Echo asked about one (or while an approval is waiting). This is enforced, not just asked for: if the quick model calls one of those tools anyway, nothing happens and the turn moves to the main model, which redoes it properly. The quick model is also told never to say it queued, saved or scheduled something unless it really did, and to answer "which model is this" only from what Echo tells it.

- Teaching mode, first part. When you say you're learning, Echo now gives one short step at a time (about 12 words, the cell named by address, never "next to"), points first, checks before the next step, repeats a step word for word on "repeat", warns about Excel's fill handle, offers undo when something else changed, and teaches clicking the cell instead of the Name Box. Underneath, a new lesson engine watches each step and checks it: it praises briefly and moves on, says "That works too" when you got there another way, corrects gently by address ("That's C5. We want A5, two cells to the left."), catches typos and wrong formula ranges, says "Oops" right away if cells outside the step got wiped (the fill-handle copy) and fixes them on "undo", hints after 20 and 45 seconds of nothing, and pauses after two quiet minutes. Repeat, show me, skip, back, pause, go on, stop, done and undo work without a model call. The Excel connection and the tool that starts a lesson come next, so lessons don't run on your Mac yet. Details: docs/teaching-mode.md.

- Echo always knows which model is answering. Every message to the assistant now says exactly which Claude model answers it (name and ID), whether the quick-model router picked it, what the main model is, and what model workers use, and a rule tells it to repeat that instead of guessing, never to claim it switched itself, and never to deny a switch Echo made. Typing `/model opus` (or `sonnet`, `haiku`, `default`, a full model ID) in the chat now really changes the main model, without a model call; `/model` alone says which one is in use. A new switch in Settings, "Quick model for simple turns", turns the quick model off so every turn uses the main model (on by default, as before).

- Echo reads back what it's about to type. Before typing or sending an email address, a phone number or another long number you dictated, Echo reads it back in one short question (email addresses spelled out letter by letter, the whole form at once rather than field by field) and types it only after your yes. A "no" or a correction keeps the misheard detail out of the field. This is enforced, not just asked for: typing such a detail before you've said yes to hearing it comes back "not typed yet". Card numbers are never read back.

- Allow on a confirmation card no longer cancels the step. When you clicked Allow in Echo's window, a scroll or the trackpad's momentum right afterwards could still make the Mac app stop the step you'd just allowed ("Create account" on Sept 30). Echo now tries such a step once more when nothing was done yet, and the Mac app ignores scrolls and mouse moves for a moment after Allow (that part needs a rebuild of the Mac app, npm run build-app). A real click or key press in another app still takes over.

- Self-improvement workers ask less for plain reads. Globs over Echo's data folder are checked against what's really there, variables a command sets for itself are understood, `head -c` no longer looks like a cookie jar to a curl on the same line, a node dry run that names the live folder runs in Node's read-only sandbox, and stopping the worker's own smoke server doesn't ask even on a line that also starts it. Ordinary tasks with read access to Echo stop getting "outside the task folder" prompts for read-only commands. Writes to Echo, deletes, secrets, the live port and network writes still ask. Details: SELF_IMPROVE.md, section 9.

- The last of the old name VoiceOps is gone. Settings are now `ECHO_*` environment variables (the old `VOICEOPS_*` names still work), the log is `logs/echo.log`, self-improve worktrees go in `.echo-worktrees`, and the window's saved preferences move over by themselves. `npm run rename-folder` moves a folder still named `VoiceOps` to `Echo` and keeps settings, memory, logs, tasks, contact aliases, worktrees and Claude sessions working; the Mac app is pointed at the new folder without being rebuilt, so its permissions stay. Details: docs/rename.md.

- Self-improve is now only available in the developer's own copy of Echo (a marked git checkout of the development repo). Installed, packaged and cloned copies can't request, unlock, start, continue or merge one: the assistant says "Self-improve is only available in the developer copy of Echo", the unlock box never appears, and Settings shows the PIN as a plain safety PIN for reset and rollback. If Echo can't tell, self-improve stays off. The existing developer checkout is recognized automatically. Details: SELF_IMPROVE.md.

- On-screen polish. When the caption pill has closed to just the orb and Echo is quiet, the orb now breathes on a slow 5.5 second cycle with a soft sunset glow that swells and eases with it, and a gentle shimmer passes over it every 20 to 30 seconds, never on a fixed beat. It's all drawn by macOS itself with Echo's frame loop stopped, so it costs almost nothing; with Reduce motion it's a still, soft glow. When Echo finishes typing into a field, one soft band of light passes over the line she typed (only when the text went in; the read-back check still decides whether the step worked, and passwords and codes are still never typed). In Echo's window, the driving banner and the "looking at your screen" pill are now one small chip ("Looking", "Driving · step 2") showing one state at a time, with the full sentence for VoiceOver. The earlier overlay work (the caption pill closing to the orb, the single status chip in the corner, the thin breathing edge line, typing character by character) is unchanged. The orb's breathing and the typing shimmer need a rebuild of the Mac app (npm run build-app); the window's chip doesn't. Details: docs/onscreen-polish-step5.md.

- Echo answers much sooner. On a timed set of everyday turns, quick replies now start speaking in about 1.3 seconds instead of 3.1, and harder ones in about 2.5 instead of 3.5. Quick turns (chat, a quick fact, one simple step) go to Claude Haiku 4.5 with no thinking pause, and it hands anything bigger to the main model in the same turn. The `fastModel` setting takes 'auto' (the default), another model, or 'off'.
- Each model call reads less than half as much: the Claude account's own connectors (Gmail and so on, which Echo's assistant could never use) are no longer loaded, long-term memory sends only its newest notes (a new recall tool finds older ones by topic), and the task list is only repeated when something changed.
- The first sentence of a reply goes to the voice as soon as it's written, instead of waiting for the next one.
- "Stop", "stop talking" and "be quiet" work instantly with no model call: Echo stops talking and drops the reply she was working on (or pauses what's playing if she was quiet). "Scroll down", "scroll up" and "go back" act at once whenever computer use is on, not only while Echo is driving.
- Lookups that don't depend on each other (two tasks, a contact and a file) now run at the same time.
- Echo now transcribes while you talk. Your audio streams to local Whisper as you speak, and it starts on your words the moment you pause, instead of after you've finished. On a timed set of spoken requests, the reply starts about a second sooner (3.2 to 2.2 seconds after you stop talking), and "stop" or "scroll down" acts 1 second sooner. The finished recording still goes through every check (the wake word, the end-of-sentence pause and the stray-phrase filters are unchanged), and when Whisper wasn't sure of what it heard, the recording is transcribed whole as before. Your words so far show live from Whisper when the browser's own live preview shows nothing. `ECHO_STREAM_STT=off` turns it off; `scripts/listen-bench.js` times it. The Mac app's own mic doesn't stream yet. Details: docs/speed-step4.md.
- The timing log records which model answered each turn and when its first words went to the voice; `scripts/dispatcher-report.js` prints both, and `scripts/latency-bench.js` times a set of turns. Before and after numbers: docs/speed-step4.md.
- No rebuild of the Mac app is needed for these.

- Echo now works from a folder with a space in its name (a shared copy in "Echo Copy", say). The tests pass from such a folder, and the safety check that lets self-improvement read Echo's own logs understands quoted paths and escaped spaces. It also got a little stricter: a path to Echo's folder written with quotes or backslashes in odd places is still treated as Echo's folder, so it still asks before changing anything there.
- New debug setting, off by default: `debugDroppedWords` in the settings file keeps the first five words of hands-free speech Echo decided wasn't meant for her, so a wrong drop can be explained later. The notes go in their own file in the data folder, anything older than 7 days is deleted (even after the setting is turned off), and the file is never included in a shared copy.
- The speed reports print two more numbers: tokens per turn (`scripts/dispatcher-report.js`) and runs that ended "done" without a confirmed last step, a sign of claimed success Echo didn't see (`scripts/computer-report.js`). The first baseline with these numbers is in docs/baseline-2026-10.md.
- No rebuild of the Mac app is needed for these.

- Conversation mode. With the wake word on, Echo keeps listening after she speaks: for the follow-up window (45 s by default, restarted every time she finishes), and for as long as a question she asked is still open. A plain "yeah", "the second one", "5 minutes" or a name reaches her without "Echo", even a minute or two later. Before, the Mac app's mic went back to waiting for "Hey Echo" 8 seconds after a question. Only answer-shaped replies count for an open question, and a long unrelated stretch inside the window only gets the "Was that for me?" chip.
- Background speech can't cancel what Echo is doing. While an action runs, "stop", "wait" or "no, go back" only cut in when they're addressed to Echo, clearly heard, short (5 words or fewer, or "Echo, …") and close to the mic (well above the room's own sound). A correction that doesn't pass is held for the next step, where the assistant sees it as possibly not for her. A stop that doesn't pass gets the "Was that for me?" chip. The Stop button, Escape, taking the mouse and "Echo, stop" always work.
- Echo notices when another app is playing sound on the Mac (a video, music, a podcast) and raises the bar while it plays. A clear direct question in a quiet room ("what time is it?") passes without "Echo", including sentences from the Mac app's mic. Every turn that got through without the wake word is noted in the speech log, so false triggers can be found. Details and the replay: docs/listening-conversation-mode.md.
- No rebuild of the Mac app is needed for these.

- "Delete it" no longer asks twice. When your own words plainly ask for a delete or a send of one thing ("delete it" right after Echo pointed at a file, "you can send it" after she wrote the draft, "send it to Sam" in Sam's conversation), that step goes ahead without a second question, and an Undo chip says what was done. It only counts for that one action, in that turn, on the same thing; if Echo would have to guess what "it" means, it still asks. Payments and purchases, sign-ins, forms, system settings, Terminal, and deleting several things or a folder always ask, and so does anything heard unclearly or from a video (the addressee check comes first).
- A plain "yes" to a waiting confirmation card now gets through in hands-free mode, and a click on Echo's own window (Allow on a card, Undo, a button) is never taken as you taking over the step.
- Fewer needless confirmations: Return in a browser's address bar, Finder's Share button (it only opens the menu), opening a System Settings pane from the sidebar, and opening a conversation in Messages no longer ask. "Try Again" on a failed message now does. Details and the replay of past confirmations: docs/safety-check-fix.md.
- No rebuild of the Mac app is needed for these.

- Fixed the Echo for Chrome extension looking connected when Echo couldn't see it. Chrome puts an idle extension to sleep after about 30 seconds, which dropped its connection while the toolbar kept saying "Echo can see this tab", and two sockets opened at start-up kept replacing each other. The extension (1.1.0) now keeps one connection alive (a keep-alive every 20 seconds, and an alarm that reconnects a sleeping extension within 30 seconds), and only says Connected once Echo has accepted it; a wrong pairing code shows as refused. Echo drops a connection that stops answering, remembers refused tries, and says why the extension isn't connected (never connected, wrong code, or disconnected when) in Settings and to the assistant; a front tab that isn't a web page (like the extension's own options) is reported as connected but no page. Reload the extension in chrome://extensions after updating.
- Clicking by label with scope "page" in Chrome never matches the tab strip, toolbar or window title any more ("Compose" clicked a tab titled "Compose Mail" instead of Gmail's Compose button): Echo waits for Chrome's page to be readable, skips the browser's own controls if it isn't, and only reads text off the screen inside the web page. Needs a rebuild of the Mac app (npm run build-app).
- The caption pill has a reply field. A small keyboard chip beside it opens a slim text field above the pill; Enter sends to Echo like a typed message, Escape closes it. When Echo ends a reply with a question it opens by itself (without taking the keyboard from the app you're in), on whichever screen the pill is on. Needs a rebuild of the Mac app (npm run build-app).

- Computer use that checks its work. Echo now looks at the app before and after every click, keystroke and scroll, and only says a step is done when it saw it work (a field holding the text, a menu opening, a new page); otherwise it says what it saw and tries another way. In Chrome it searches the web page, not Chrome's own tabs and profile button, clicks the button rather than the text inside it, and types only once the right field has the cursor (no more greetings in the To field, text typed twice, or ⌘⇧M opening Chrome's profile menu). New: right-click, hover, drag, triple-click, clear a field, "show me how" mode (Echo points, you click), an Undo chip after sends and deletes, Gmail in one step ("email Sam…", with a card showing the recipient, subject and first line before sending), photos in iMessages, saving a picture from a link, Spotlight search on memory cards, iCloud Drive or the open Finder folder, FaceTime and Settings panes by link, YouTube controls, and instant commands (pause, next, volume, scroll, go back) with no wait. Optional: the Echo for Chrome extension (in the extension folder; pair it in Settings) reads pages directly. Speech that might not be for Echo now gets a small "Was that for me?" chip instead of being dropped, "You can send it" after she asks is heard, and a video saying "subscribe" isn't. Needs a rebuild of the Mac app (npm run build-app). Details: docs/computer-use.md and PROGRESS.md.

- About a second faster on most things you say. The speech correction pass (Claude Haiku, about 1 s) used to run on every sentence, but it changed only about one in five, mostly grammar ("we" → "we're"), and now and then it swapped a correctly heard name for another one. Now it only runs when a sentence has something it could fix: a word in no dictionary and none of your names, a word or two that sound like one of your names without being it ("horizon" for a project called Horizo, "track sticks" for Traxstix, "cloud" for Claude), a number, a learned mishearing that's also an everyday word ("football" for Foodbowl), or a word the recognizer was unsure of. Replayed on 523 logged sentences: 64% skip it (about 1.1 s each), and one name would have been missed (an everyday word that shares no sounds with the name). Plain sentences are ready in about 20 ms. `ECHO_CORRECTION_GATE=off` brings back the old behavior; `node scripts/correction-replay.js` re-runs the replay on your own log.
- `node scripts/dispatcher-report.js --since <date>` works again (the date was read as the log file), and it now also shows speech-to-text and correction times from `data/stt-log.jsonl`.
- New `node scripts/computer-report.js`: how computer use really went on this Mac, from `data/computer-log.jsonl`. It shows runs finished, how they ended, verified actions and seconds per step, overall and per app, next to the simulated `npm run eval`.

- Fixed Allow on a computer-use confirmation card cancelling the very step it allowed ("the user took over"), so a risky step like clicking Send in Gmail now really happens. Clicks, scrolls and keys aimed at Echo's own windows (the main window and its cards, the caption pill, the companion orb) no longer count as taking over; only input in other apps does. After Allow, Echo waits a moment, brings the app it was working in back to the front, then acts. A spoken yes after Echo asks now answers the card even if the assistant had to try the step again. Needs a rebuild of the Mac app (npm run build-app).

- Self-improvement tasks no longer get stuck at "running" after they finish. A follow-up sent while the worker was busy was usually answered in the same turn, but Echo kept waiting for a separate answer that never came (tasks 61, 65 and 118). Echo now finishes the task once the worker goes quiet, ends a worker whose session won't close after its final answer, and gives each review check and the whole review a hard time limit, killing anything a check leaves running. If the checks time out or can't run, the changes still go up for review, with a note saying so. A self-improvement task can also stop its own test processes (a smoke server on the test port, a test build in a temp folder) without asking; stopping anything else, above all the live Echo, still asks.

- Fixed the Mac app's caption pill never showing any words: it was an empty tinted bar because its drawing sat under the blur. Your words, Echo's line and the status now show; with nothing to say it closes to just the orb (or the orb and Stop while driving), including the first time it appears. The orb now sits centred in the pill's rounded end with even padding, and the screen-edge glow follows a MacBook's rounded display corners and stops short of the notch (square on external monitors). Details: docs/overlays-polish.md. Needs a rebuild of the Mac app (npm run build-app).

- Minimal on-screen overlays in the Mac app. The big "Echo is driving · Esc to stop · click or type to take over this step" banner is gone. While Echo looks or drives, a thin (1.5 pt) coral-to-tangerine line glows softly around the very edge of the screen and breathes gently (still with Reduce motion), instead of the thick orange border. One small status chip in the top-right corner shows a single state at a time (Looking, Driving, Clicking, Typing…), crossfades between them and shrinks to a dot after a few seconds, so "Echo is looking at your screen" no longer stacks on the driving banner. The Escape hint now shows as "esc to stop" beside Stop in the caption pill for the first seconds of a drive, then fades. With nothing to say, the caption pill closes smoothly to just the orb (or the orb and Stop while driving) instead of sitting as an empty amber bar, and opens again when there are words. Before and after: docs/overlays-polish.md. Needs a rebuild of the Mac app (npm run build-app).

- A calmer listening section under the orb. The status just says "Listening" (the first few times you hold Space it adds "release Space to send", then stops), and no speech engine names show in the main window. Your words appear live in a slim graphite caption pill, two lines at most: the newest words brightest, older ones dimming and scrolling away. The orb swells gently with your voice and settles in pauses (with the Mac app's own mic too; Reduce Motion brightens it instead). "Didn't catch that" now only shows when nothing at all was heard, fades in where the caption was once your words have cleared, and fades out by itself. Before and after: docs/listening-polish.md. The orb following the Mac app's mic needs a rebuild of the Mac app (npm run build-app).

- New Settings. The crowded side panel is replaced by a settings window with sections on the left: General, Voice & listening, Companion orb, Computer use & permissions, Music, Account & AI, Updates, and Privacy & safety. Every setting has a one-line description, and a search box finds any of them ("/" jumps to it). The companion section previews the orb at the size you pick; the voice picker has a play button for a sample. Computer use shows each Mac permission live (Screen Recording, Accessibility, Microphone, Input Monitoring) with a Fix button that opens the right page of System Settings. Account & AI shows your Claude sign-in and today's usage. The ambient piano now has a volume slider. Settings opens with the gear or ⌘, and closes with Esc; the keyboard stays inside it while it's open. Settings that need the Mac app stay visible but greyed out in a browser. The top bar is down to hands-free, new chat and the gear; the piano, voice menu and "Hey Echo" mic-off switch moved into Settings, and today's cost into Account & AI. Screenshots are in docs/screenshots/settings.

- Companion polish, closing the last gaps with the mockup. While Echo drives, the pill shows which step she's on ("Moving to **Send** · 3 of 3", or "step 2" when she hasn't guessed a total) with the mockup's thin sunset progress line under it. While she speaks, the orb has a soft glowing halo, and her line lights up word by word in time with her voice: upcoming words wait faintly and fade in as they're said (from the voice's own timings, or an estimate), and a long line glides along with the word she's on. Typing on screen is now character by character at a natural, slightly varied pace (faster for long texts, never more than about 3 seconds), with the orb bobbing gently beside the caret, a soft glowing caret and a small glint on each new character. If the first characters don't land it sets the field or pastes instead (the clipboard is put back); it still never types into password fields, checks again as it types, and stops the moment you take over. With Reduce motion it types at once, as before. Needs a rebuild of the Mac app (npm run build-app).

- The companion and the caption bar now match the approved mockup. The caption bar is a slim 44 pt graphite pill at the bottom centre, just above the Dock: your live words (newest brightest) or Echo's line, a one-line status of what she's doing ("Clicking **Send**"), a round Stop button, and, when she asks before a risky step, the question with **No** and **Yes** (they answer the same card as her window). It hugs its text, rises in, cross-fades between lines, scrolls Echo's long lines along as she speaks, dims when your mouse is over it, and never takes focus (over full-screen apps too). The companion orb lives in the pill's left slot, breathing while you talk and rippling while Echo speaks; when she points or acts it glides out on an arc, the target glows faintly then fully, it pulses and throws a small glint just before the click, sparkles, and glides home. Motion now runs on the display's own clock (up to 120 Hz), with soft launches, no kinks when the target changes, and a spring that follows the pill. Settings → Screen: Companion size is now Small, Medium (the mockup's 28 pt, the default) or Large, and there's a Reduce motion choice (same as macOS, on or off); existing sizes carry over. docs/companion-mockup-comparison.md shows the mockup and the app side by side. Needs a rebuild of the Mac app (npm run build-app).

- The companion got a design polish pass to match the mockup: it's now the mockup's sunset drop (honey to coral with a dusk-violet rim, a thin light rim, a soft highlight and shadow), 28 pt by default. It glides on a gentle arc with a faint comet trail and parks just outside the target's corner, leaning toward it, with a honey outline on the target. Listening shows a halo and swells with your voice, thinking cools to violet with a comet circling the rim, speaking rolls out rings on the peaks of Echo's voice, a click is preceded by a squash-and-pop, done gets five tiny stars and a bounce, and an error a soft wobble and a cooler tint. It steps aside when your mouse comes near. Reduce Motion shows states by colour and halo only. Needs a rebuild of the Mac app (npm run build-app).
- Echo's big orange pointer is now a tiny living companion: a small glowing sunset orb (coral to tangerine with a soft gold heart) that drifts smoothly to whatever Echo points at or is about to click, with a quick faint trail, and never jumps. It breathes when idle, swells with your voice while you talk, swirls while Echo thinks and ripples while she speaks. Before a click it pulses and sparkles at the spot; a finished step gets a tiny sparkle and a failed one a soft wobble (no red alarms). Pointing, guide mode and computer use work exactly as before; only the look changed. It never takes clicks or focus, shows over full-screen apps, and with Reduce Motion it fades instead of drifting. Settings → Screen → Companion size (small or medium). The page's own pointer (the first-run demo) is the same orb.

- Faster, much cheaper replies. Echo no longer carries one ever-growing conversation (it had reached about 800K tokens, about 4 seconds and 40 cents per model call). Once the conversation passes about 60K tokens, 40 turns, half an hour of quiet or a new day, she starts a fresh one with a short summary (written by a small, fast model), the last few exchanges word for word, and anything still waiting on you: message cards, "should I click Send?" confirmations and an open driving session, with their ids. She never switches mid-drive unless the conversation gets very large. Replayed on Sep 28's evening: context 716K → 49K tokens (p50), about 3.8 → 2.1 seconds per model call, and input cost about a tenth. The per-message task list is slimmer too (active tasks and ones finished in the last 15 minutes; older ones are a count). Settings → Usage shows today's cost with the conversation on its own line, and gives a soft heads-up past a daily amount you pick ($20 by default). Timings are logged in data/dispatcher-timing.jsonl; `node scripts/dispatcher-report.js` prints them. Limits can be tuned with `ECHO_ROTATE_TOKENS`, `ECHO_ROTATE_TURNS`, `ECHO_ROTATE_IDLE_MIN` and `ECHO_ROTATE_HARD_TOKENS`.

- No more canned "Hmm, okay" or "Sure, checking." Echo no longer says a stock acknowledgement the moment you stop talking, or a filler when she starts using tools. Instead the sunset (and the caption bar) quietly switches to thinking right away. When something will take more than a few seconds, she says one short line about what she's actually doing ("Checking Fortuna's staging."), written by the assistant itself and never repeated. Settings → Voice has "Spoken acknowledgements" (a short, specific line before any tool work) and "Thinking sound" (a very soft tick when she's heard you); both are off by default.

- Echo can see your screen, when you ask. Say "what's this error?", "help me with this page" or "what am I looking at?" and she takes one look at the screen you're working on. In the Mac app the text is read on your Mac (Apple's on-device text recognition), and password fields, API keys, tokens and card numbers are blacked out in both the picture and the text before anything is sent; the picture itself only goes to the assistant when the text isn't enough. A small "Echo is looking at your screen" pill shows while she looks. Screenshots are never saved, and the log only notes that she looked. In a plain browser she asks you to share a screen each time and shows you the picture before it's sent.
- Echo can point. Ask "where's the share button?" and a soft sunset pointer flies to it and rings it with a glow, so she can say "click here". She finds buttons, menus and links by name with the Accessibility API, and falls back to the text on screen. She never clicks for you.
- Echo can walk you through things. Ask "where's Wi-Fi?" or "show me how" and she points at each step and says it ("Step 1. Click Control Center"), waits until you've clicked it (she watches the panel open), then points at the next one. A step counter shows in the window. She finds menu bar items and status icons too (Control Center, Wi-Fi, Bluetooth, Sound, Battery), and never clicks for you in this mode.
- Echo can use the computer for you, if you switch it on (Settings → Screen → "Let Echo use the computer"; off by default). "Open Chrome and search for otters, then tell me what shows up", "open Claude and ask it…", "go back": she clicks, types, presses keys, scrolls and waits for pages, checking the screen after each step. She still sends texts, adds events and opens links the direct way. While she drives, a glowing border runs around the screen and the pointer moves to each spot first; press Esc, or touch the mouse or keyboard, and she stops at once. She asks first (out loud and with a card in the window) before sending, buying, deleting, submitting, signing in or changing settings; never types passwords, codes or card numbers; never acts in her own window or in the Privacy & Security settings; stops after 25 steps or 5 minutes; and logs each action with typed text redacted. Needs Accessibility and Input Monitoring. Details and a test plan are in docs/computer-use.md.
- Just answer. When Echo's reply ends with a question ("Should I send it?", "Which one?"), the mic opens quietly for 8 seconds once she has completely finished speaking, so you can answer without Space or "Hey Echo". The voice pulses softly and a thin "Listening…" line shows; no chime. If you say nothing it closes by itself. Works with hands-free on or off; change the length (or turn it off) in Settings → Speech recognition.
- The answer window after Echo asks something is now as careful as hands-free: a plain answer ("yes", "the second one") still needs no "Echo", but a TV, another language, something heard only faintly, or a long stretch of unrelated talk is left alone instead of becoming a turn. And her conversation is never switched to a fresh session between her question and your answer, so the answer lands where the question was asked, fast.
- Signing: `ECHO_SIGN_IDENTITY=local` makes the Mac app build always use the self-signed "Echo Local Signing" identity (made once in your keychain), even if you have an Apple certificate. docs/mac-permissions.md now covers the Microphone permission too, and how the local identity was checked in a throwaway keychain.
- Talk to Echo while she drives. During computer use she keeps listening between her words: "stop" ends the run at once (like Esc), and anything else ("no, search for X instead", "go back", "open Claude now") reaches her before her next step. Your voice never counts as touching the mouse or keyboard. She narrates each step in a few words ("Opening Chrome…", "Searching…") and tells you what she sees at the end.
- Truly hands-free driving. The Mac app now has its own mic (Apple's voice processing: echo cancellation and noise suppression), so Echo hears you whichever app is in front: no switching back to her window, no Space. During a driving session she listens all the time ("click the first video", "click the MrBeast video", "the one in the top right corner", "scroll down", "go back"); outside a session "Hey Echo" works from any app, and Control + Option records with it too. Talk over her while she drives and she stops speaking at once. While you talk in a session the Mac's volume dips so she can hear you over a video, and comes back after (unless you changed it yourself); the speech detector follows the background noise. Live words show in the caption bar (Apple's on-device recognition only). The window's mic is still the fallback. Settings → Screen has switches for all of it.
- Taking back control is gentler. Small mouse movements are ignored; a real click or key press stops only the step Echo is on, and she says "Okay, go ahead" and keeps listening for your next command. Esc, "stop" or "that's all" end the session. Prefer the old way? Settings → Screen → "End the whole session".
- "Click the first video": for things you point at by place or look, Echo takes a look at the screen, finds it in the picture and clicks it by its title, or right on it.
- Driving is a conversation now. After a request she stays in the app and keeps listening, so you can chain: "now search for something else", "go back", "scroll down", "read me the top result", "open Spotify and play X". Say "that's all" (or "stop", press Esc, or take the mouse) to end it; a quiet minute ends it too.
- Echo's own window no longer gets in the way. Before every click, keystroke or scroll she brings the app she's working in to the front and waits until it really is; typing into Chrome was sometimes refused because Echo's window sat behind it. A focus miss is retried once and then reported, without ending the session.
- Faster direct paths: Apple Music and Spotify play, pause, skip and search-and-play without touching the screen, YouTube and Google searches open straight from a link, and a file you asked about opens in the app you name (Excel, Numbers…). The assistant also has short recipes for Chrome, Safari, the Claude app, Finder and Notes.
- A floating caption bar (Mac app): while Echo drives, or her window is hidden or behind other apps, a small graphite-glass bar at the bottom of the screen shows what you're saying, what she's saying, and what she's doing ("Driving: Chrome", "Waiting for you to confirm"). It floats over full-screen apps, lets clicks through, moves out of the way of what she's working on, and has a Stop button. Turn it off in Settings → Screen.
- Mac permissions now survive rebuilds and updates. Echo.app is signed with the same identity every time (your Developer ID or Apple Development certificate, or a local "Echo Local Signing" certificate made once), so macOS stops forgetting Screen Recording, Accessibility and Input Monitoring. Allow them once more after the first such build. Settings → Screen lists each permission with an Open button for its exact System Settings page, and says how the app is signed. See docs/mac-permissions.md.
- Fixed: the Mac app didn't build after the guide-mode update, and guide mode couldn't point at menu bar items (Control Center, Wi-Fi).
- Hold Control + Option from any app to talk, even when Echo's window is behind others; let go to send. Space and "Hey Echo" still work. Pick another chord (or turn it off) in Settings → Screen.
- "Fix the error on my screen": a coding worker gets the redacted screenshot (a temporary file deleted when the task ends, or after 30 minutes) and the text from the screen along with its instructions.
- Setup has a 30-second "Try it" step: hear Echo, let her read your screen (the demo sends nothing anywhere), and watch her point at a button. In the Mac app, the permissions step now covers Screen Recording, Accessibility and Input Monitoring.
- Settings → Screen: switches for screen awareness and the pointer (both on, and Echo still only looks when asked), the push-to-talk chord, and the Mac permissions.
- The learned speech correction "Hey Claude" → "Hey Clicky" was saved by mistake and turned every "Hey Claude" into "Hey Clicky". It's dropped once on start-up (with the word it added); teaching it again on purpose still works.

### All changes

- Remove personal names from tests, comments and docs before the public release
- Changelog: release 1.3.0 now; the ChatGPT sign-in comes in a later version
- No repeated answers, one call less per game move, and a fresh session without waiting for silence
- Changelog spacing after the merge
- Fix Chrome extension reconnection for reliable form filling
- The review card's View changes and Merge buttons work again
- Start a fresh session at 80K: the first word comes later the fuller the session is
- First look stays fast; the circled square leaves when the work is done
- Scrolling goes to places: into view, where the page is, remembered places, find, read-along
- Keep an eye on it: Echo watches a window by itself and says when it ends
- Two measured slow spots: the quick model's wrong "not for me", and resets every few turns
- One thread: where we are, what was heard, and walk-throughs at the user's pace
- Stay out of talk that isn't for Echo; read back before sending; copy the conversation
- The rest of the firefly moves: two lights, the curious loop, a nod with Echo's yes, all toned down
- Draw with the light, and notes that stay
- Firefly moves: nod, shake, spiral, thinking eight, curious lean, heartbeat, comet tail, sleepy, stepping stones
- Echo beside the thing: the Aurora bubble, asking at the thing, a light that wanders
- Typed replies: the reply field after a typed turn, and answer chips
- One way of listening in three states, and one key
- Faster first sound: cut the old answer's voice, a shorter pause when idle, less thinking
- Stay in the conversation, never answer its own voice, one yes for a screen share
- The Sky: every day with Echo as a constellation that can be played
- Play-along, quiet mode, and promising only what is done
- The light waits between a job's steps, its words land with it, and its trips are logged
- CHANGELOG for the Oct 6 session fixes
- One yes covers a job's own files; a waiting approval is mentioned once
- Explain by showing: Echo walks through what is on screen in small pieces, pointing at each
- The message card says when a file did not attach; no second send on a guess
- A file that never attaches in Messages is reported as not attached, never as sent
- Small text files in one step: write_file, read_text_file, undo_write
- The quick model never says Echo can't; a stop in the window is not an error
- Open the sound output afresh after a quiet stretch; sources are shown, not read out
- More expressions for the pearl: working, content, curious, a nod, a wink, thinking hard
- The second listen never runs inside the tests
- The gradient also means Echo is hearing you (the live bubble, the level bars, the message box)
- Tests follow the joined bridge and the caption setting
- Speed row layout, tests follow the caption setting, CHANGELOG
- Join the Settings rows to the Mac app, and keep the caption a real setting
- Settings: 73 rows down to 30, in five sections
- The menu bar menu shows what Echo is doing, and set-once options move to Settings
- Talking no longer takes the window over once there is a conversation
- A second listen: Whisper checks each sentence Apple wrote, and the turn is done again when it heard better
- The recognizers are told what the conversation is about
- CHANGELOG for the Oct 4 second-session fixes
- A no can't be got round, AirDrop asks, and one yes covers one intent
- A sheet write takes thousands of cells in one call; sample data is made by Echo; only dictated values are read back
- Types in the transcript test
- Message_status is a read-only tool
- A conversation log: what was said and answered, with its time
- After a text, Echo says what it knows about delivery, not "they got it"
- A wrong quiet is asked again; the summary keeps what was done; no hand-off text or raw errors
- The trace test follows the soft flag on a delivered sentence
- Never silent to something said to Echo; a soft yes is asked about; show me where points
- The menu bar mark is the three bars; the starting screen matches the app
- The strip test no longer pins the removed guide pill style
- CHANGELOG for one teaching feature; drop the guide pill style
- One way of walking the user through an app: guide is now a quick lesson
- A local judge that never answers is left alone after three misses; CHANGELOG
- Answer time: a word at once when a tool comes first, and a head start on judging
- A native permissions checklist, shown on first launch and from the menu bar item
- Personal tools keep only their name in the turn record and the activity line
- Voiceend test: a click Echo doesn't ask about (saving now asks first by default)
- Brief test: say carries the voice line's id
- CHANGELOG: What happened, place hints, voice signals, app adapters, Labs defaults, XD bridge
- A bridge to Adobe XD: a panel plugin, /ws/xd, and a probe of when XD allows edits
- Labs switches on by default; hints and verify become how Echo works
- Echo knows when its own voice starts and stops
- App adapters: Finder, Notes, Reminders, Calendar and Mail without clicking
- Hints that say where: the app reports a target's place, and lessons ask with locate
- Settings: a "What happened" view of the timeline, and a "…" on each reply that opens its turn
- CHANGELOG: show me, the story, fading
- Lessons: a watchable "show me", the story, and fading across lessons
- CHANGELOG: spreadsheet adapter, step caption, speech timed to the light, the help ladder
- Lessons give help one rung at a time: wait, prompt, hint, point, do part, do it
- Echo says "this" as its light lands
- Spreadsheets go through Excel's and Numbers' own scripting, not clicks and keys
- A small caption beside Echo's light says what each step is
- CHANGELOG: fixes from the first real session
- Excel and Numbers: the grid takes typing, a cell is one step, replace really replaces
- Oct 3 session fixes: sentences no longer cut off, no silent drops, lessons that don't get stuck
- CHANGELOG: companion review fixes
- Companion and firefly review fixes: no hung routes, no stuck light, no screen capture for the look
- The firefly's Mac side: it waits, searches, walks menus, takes its colour from intent, and can be picked up
- The companion is never a blank space: a still picture while its animation is paused
- CHANGELOG: the rebuild (look, companion, island, firefly, listening engine, judge, turn engine, lessons, quit, timeline)
- Page: a 'Pointed at …' line, the Companion section's name, a pinned test
- The firefly's server side: point back, waiting in lessons, routes through menus, intent, search called off
- The companion has two bodies you can pick, and playing with it no longer toggles the mic
- The companion comes alive in the Mac app: a glass pearl with eyes, whose light does the pointing
- Listening engine review fixes: the mic opens only when needed, stalls are noticed, no page means no listening
- Echo's companion comes alive in the window: a glass pearl with eyes and a rim of light
- E2e: the app's own transcription is always used (no switch)
- Mac app review fixes: exact-label waits, the island during drives and drops, Quit gaps, the pointer over menus
- One listening engine: the app's mic and one state machine for every way of talking to Echo
- The new look: the three-bar mark replaces the orb, and the window goes black, white and quiet
- Fix what the review of wave 1 found, server side
- The island and the living mark replace the caption pill and the orb in the Mac app
- The conversation window is the only way of listening: the page's last flag checks go
- Who Echo listens to: the owner's level, duplicates by time, onset windows, no silent drops
- Lessons no longer skip ahead, plans are mended not refused, and screen reads fail fast
- Turn engine: folded replies close their turns; Echo's notes stay private
- Quit means quit, and a caption pill that cannot get stuck
- The flight recorder: one timeline from the Mac app, the page and the server
- A new icon and mark: Fade (three bars: white, grey, colour)
- E2e: the flag-off check picks the browser engine, so it never starts Whisper
- E2e: the Apple speech test no longer assumes Whisper is absent
- Second review fixes: catch-up only as the whole sentence, rule lookup, labels
- Catch me up: "what did I miss?" answered at once (flag catchUp)
- Clearer words: take-over line, quiet user stops, no Whisper speaker labels
- Groundwork review fixes: tool strings, Looking chip, Esc, accent, static crash
- Agent review fixes: calmQueue repeats and stop, rule matching, job age, limits, report
- Voice review fixes: Apple speech finish order, timeouts, soft barge, turn end bounds
- "Can you hear me?" always answered; retries and plan limits known (calmQueue)
- No pile-up while Echo is slow (flag calmQueue)
- Shortcuts the app really has: a ⌘ shortcut that did nothing is checked against its menus
- A typed line break never sends a message: Shift+Return, Return only in a terminal
- A report for whoever helps you: shown in full, saved, never sent
- Release gate: tests, type check and golden tasks before any release
- Leaner context: compact tool results, no screen-acting tools when off
- Spending limits: per worker task and per day (off unless set)
- Per-app skills: a way that worked twice is kept and followed (flag skills)
- Preferences as rules: what the user always wants, kept and followed (flag rules)
- The job journal: a goal and its progress survive session swaps and restarts
- Done contract and critic: done only when the screen says so (flag critic)
- Milestones instead of the step cap (flag milestones)
- Look at just the window you're in (flag windowCrop)
- Golden tasks: run the eval suite three times and keep the results
- Exact typing, and no second click on a switch (flag verify)
- Postconditions: a click counts only when the right thing changed (flag verify)
- Soft barge-in: lower her voice first, stop on real words (flag softBarge)
- Time the voice's first sound, not just the first sentence
- End of turn from the words so far (flag smartEnd)
- One ear in the app: window push-to-talk records with the app's mic (flag appMic)
- Apple's speech recognition in the Mac app's mic (flag appleSpeech)
- The scorecard: 15 numbers from the logs, for any stretch of days
- Crash-safe state: write whole or not at all, keep the last good copy
- No personal assumptions: accent from the Mac's region, settings cached
- Provider interface: the conversation's model behind lib/brain/provider.ts
- Split the page: views move from public/app.js to public/ui/
- Split server.js: listening, API routes, the page's socket, HTTP helpers
- Split computer use by job: speech, keys, risk, limits, tools
- Split the dispatcher: the assistant's tools move to lib/tools/
- The Mac app's own line to the server (/ws/body), with a token
- Turn engine: queued turns keep their own records; unread input survives a session swap
- Make the server testable end to end: start()/stop() and exports
- Fewer interruptions: background digest, one question for several approvals, local commits
- Pointer safety: find the Apple menu, never point at Passwords or the Keychain
- Cards that hold: block the plan, bind to what was approved, read back only dictated details
- Stage 2 approvals: ask by what an action does, in four tiers
- Show the conversation window: ring, countdown, chimes, caption bar
- Stage 1 listening: conversation window, one judge with context, nothing silently set aside
- Replay: every past sentence through the real decision, labelled from the evidence
- Speech reaches Echo as heard; names are hints, not rewrites
- Fixes from the Oct 2 test: brief voice enforced, corrections only from the user, short app names
- Brief voice (beta): speak the key point, show the details
- Move the after-transcription decision into lib/pipeline/utterance.ts
- One trace id per turn, through every log, plus turn milestones
- Core groundwork: TypeScript, Node 22.18 floor, feature flags, ADRs
- Premium voice while it's free, Kokoro as the backup
- Apply Echo voice measurement patch and pass review checks
- Apply patch to Echo and run review checks
- Apply Echo patch 0004 and verify with review checks
- Apply patch 0003 to self-improve branch and verify with review-checks
- Fix quick-model routing to prevent inappropriate task creation
- Build guided teaching mode for Echo walkthrough
- Add model name and ID to Echo's context
- Step 2 of the Oct 1, 2026 plan (step 1, the VoiceOps to…
- Rename VoiceOps to Echo throughout project
- Restrict Echo self-improve mode to development copy only
- Fix read-only command classification in safety filter
- Step 5 of the Echo build plan
- Stream live transcription during speech input
- Fix hands-free mode infinite listening bug
- Implement Echo speed optimization work
- Improve Echo's listening and wake word response
- Build Step 2 of the Echo build plan (ECHOBUILDPLAN.md in the…
- Build Step 1 of the Echo build plan (ECHOBUILDPLAN.md in the…
- Debug Chrome extension WebSocket connection issue
- Apply speech-correction patch and verify checks
- GOAL
- Fix Echo computer-use confirmation bug with mouse click detection
- Unblock task 118 by marking it ready for review
- Redesign Echo overlays to be minimal and premium
- Polish Echo's listening status and live caption display
- Allow approved read-only access to Echo's own code
- Redesign Echo settings with modal interface
- Polish companion UI and add typing animation
- Make Echo's on-screen companion orb match (and beat) the…
- Polish companion orb animations and visual effects
- Replace Echo's cursor with animated companion orb
- Rebuild auto-listen and persistent permissions on current codebase
- Top-priority speed + cost fix
- Smarter "is this for me?" listening
- Remove generic spoken acknowledgements from Echo
- Make Echo's personality persistent across all users
- Enable voice commands during hands-free driving
- Fix Echo's focus bug during computer use actions
- Resolve merge conflicts and re-land self-improvement task
- The native Echo Mac app (macos/) no longer compiles after…
- Build step-by-step guide mode with computer use capabilities
- Fix pointer centering bug in screen-aware Echo
- Build screen-aware Echo with on-demand capture

## [1.2.0] - 2026-09-28

- Say "Hey Echo" (or just "Echo") to talk, hands-free, as well as holding Space. Echo listens for her name on your Mac only: a light loudness check runs all the time, and each burst of speech is checked by the local Whisper model; nothing is sent anywhere or saved before the wake word. When she hears it, a soft chime plays and the sunset lights up, and your request is recorded until you pause ("Hey Echo, check the build" in one breath works too). She never wakes on her own voice (the listener is muted while she speaks), and when she's just asked you a question you can answer without saying her name. On by default; Settings has the switch and a sensitivity slider, and the "Hey Echo" pill at the top turns the mic off completely. Needs local Whisper (`npm run setup:whisper`). On test recordings it woke on 3 of 3 of your own "Hey Echo"s and never on 19 of your other clips; details and idle CPU are in docs/speech-recognition.md.
- Echo sounds like she's speaking, not reading: her voice gets whole sentences (a short reply in one go) instead of comma-sized pieces, the silence the voice engine pads each piece with is trimmed, and pieces join with a short, natural breath. With ElevenLabs, each piece also carries on the intonation of the one before. She's told to open with a short first sentence so she still starts quickly.
- No more answering a bare ".": when the final transcription comes back blank (or much shorter than what the live listener showed), Echo uses the live text; if nothing was heard at all, nothing is sent, a small "Didn't catch that" note appears, and she says so softly once. Each blank clip is saved with its loudness and the mic's state in the speech log, a microphone stream that has gone silent (after sleep or a device change) is reopened, and push-to-talk now really keeps the last moment after you let go.

- Echo hears your project and contact names much better. Whisper now gets a short list of just the unusual names you say (spelled the way you say them, most important last) instead of a long list it mostly ignored, and Echo uses the full large-v3 Whisper model when it's downloaded (`npm run setup:whisper -- --accurate`, about 1.1 GB): on test clips in Indian-English voices it got 12 of 12 names right, against 4 of 12 before, for about a third of a second more.
- Speech correction never swaps in a project or contact you didn't say: a name only goes in when it sounds like what was heard or is a nickname you've confirmed. Otherwise your words stay as heard and Echo asks.
- Spelling a name out works even when a letter or two is misheard: the letters are matched to your projects, contacts and vocabulary.
- Echo listens properly again. Pauses are squeezed out of each recording before Whisper hears it (long silences made it skip and invent whole sentences), and a recording with no real speech in it, like a click or a breath, is never sent, so phantom "Thank you" turns are gone. Whisper's stock silence phrases (a trailing "you", "Thanks for watching") and segments it was only guessing at are dropped, and you see "Didn't catch that" instead. When the final text is a different sentence from what the live preview showed, the live text is used. On your own saved clips, made-up turns went from 4 of 4 to 0 and word errors from 37.5% to 15%. On Indian-English test clips, word errors went from 6.6% to 4.0% (11.9% before the name change). Details are in docs/speech-recognition.md.
- Echo stays on the turbo Whisper model even when large-v3 is downloaded: on real speech, large-v3 made twice the errors and was slower.
- Clicking the mic (or using the Mac menu) stops listening by itself after you finish talking, or after 8 seconds of nothing, so an open mic no longer records the room. Hands-free now only answers when you say "Echo" or reply right after her (new setting, on by default), and a turn that's just Echo's own voice picked up by the mic is ignored.
- Each turn's speech-log entry records every stage (the live text, Whisper's text with its confidence, what was dropped and why, and what was used), so a misheard turn can be traced.
- Echo's own voice is kept out of your recordings: the mic ignores everything while she speaks and for a moment after, so a clip never starts with the end of her reply. Each clip notes whether echo cancellation was really on, and the last 20 clips are kept (in the data folder) so a misheard sentence can be checked.

## [1.1.0] - 2026-09-25

- The installer works on a brand-new Mac: Node.js now comes straight from nodejs.org (the right build for your Mac, checked against its official checksum) into Echo's own folder, so it no longer needs git or Apple's developer tools. Apple's Command Line Tools are checked at the start; if they're missing, Apple's installer opens while everything else carries on, and if you skip it Echo opens in the browser instead.
- Setup has a new "Sign in to Claude" step: it shows whether you're signed in, opens the Claude sign-in in your browser, explains a Claude Pro or Max plan versus a pay-as-you-go API key, and confirms it works with a tiny test message. The installer now installs Claude Code without asking.
- Echo starts talking sooner: her voice begins at the first comma or phrase instead of the end of the sentence, the pieces play back to back with no gaps, the voice engine stays warm, and she says a quick "Sure, checking." the moment you stop talking.
- Echo always knows where every task stands (status, latest activity, pending approvals and how risky they are), so "where are we?" gets an instant answer.
- Task news never cuts Echo off: it waits until she's finished, then comes in with a short "Oh, and…". Approvals you've already answered are never announced.
- Task updates show in the chat as compact cards with a task chip and a status colour; approvals have Approve and Deny right on the card, and shrink once answered.
- The sunset shrinks to a small glow at the top when Echo is idle, giving the chat more room, and grows back when she listens, thinks or speaks (instantly, with reduced motion).
- A new app icon: Echo's glass sunset drop over the water, drawn for every size from 16 to 1024 pixels.
- Release tools: confirmations can be piped in or skipped with `--yes`, and `npm run release -- --current` prepares the current version without bumping it.

## [1.0.1] - 2026-09-25

- One-line install from GitHub (`install-remote.sh`), with a verified download.
- Echo updates itself from GitHub Releases: a daily check, an "Update available" card, "Update now", an optional automatic install, and an automatic rollback if a new version doesn't start.
- The setup wizard shows how far the voice download is.
- Speech correction no longer swaps a spelled-out name, a contact or a vocabulary word for something else, and never puts in your own name for someone else's.

## [1.0.0] - 2026-09-25

- First shareable version of Echo: a voice assistant for your Mac that runs Claude Code workers for your projects, research and everyday errands.
- Setup wizard, beginner mode and safe mode, Reset Echo, and a privacy check that keeps personal data out of every package.
- A native Mac app with a menu bar icon and a summon shortcut.
