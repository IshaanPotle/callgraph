/**
 * Vocabularies and utterance templates, per vertical.
 *
 * The rule every template follows: a fact is *implied*, never announced. No
 * customer says "my objection is that the price is too high" — they say "yeah
 * that's, that's a bit steep for what it is." If the templates stated facts
 * cleanly, extraction would be string matching and the eval would report 99%
 * on a task nobody has.
 */

import type { Outcome, Sentiment, Vertical } from '../core/types.js';

export interface Utterance {
  speaker: 'AGENT' | 'CUSTOMER';
  text: string;
}

export interface CodedLines {
  code: string;
  label: string;
  lines: Utterance[];
}

export interface VerticalSpec {
  id: Vertical;
  company: string;
  agentNames: string[];
  productLines: { code: string; lines: Utterance[] }[];
  reasons: CodedLines[];
  objections: CodedLines[];
  outcomes: { code: Outcome; lines: Utterance[] }[];
  competitors: string[];
  competitorLines: (c: string) => Utterance[];
  disclosure: Utterance[];
  escalation: Utterance[];
  sentiment: Record<Sentiment, Utterance[]>;
  amount: (formatted: string) => Utterance[];
  commitment: (spoken: string) => Utterance[];
  filler: Utterance[];
  greeting: (agent: string) => Utterance[];
  closing: Utterance[];
}

const u = (speaker: 'AGENT' | 'CUSTOMER', text: string): Utterance => ({ speaker, text });

// ---------------------------------------------------------------------------
// Field service dispatch
// ---------------------------------------------------------------------------

const HVAC: VerticalSpec = {
  id: 'hvac',
  company: 'Meridian Comfort Systems',
  agentNames: ['Dana', 'Marcus', 'Priya', 'Rosa', 'Teddy', 'Grace'],
  competitors: ['ClimateWorks', 'ArcticAire', 'TrueTemp Home'],

  productLines: [
    {
      code: 'Residential HVAC',
      lines: [
        u('CUSTOMER', "it's the main system for the house, the one you all put in"),
        u('CUSTOMER', 'the central air, the whole-house unit'),
        u('AGENT', "okay so this is the residential system, the one in the—in the crawlspace, right"),
      ],
    },
    {
      code: 'Commercial Rooftop Unit',
      lines: [
        u('CUSTOMER', "we've got the two units up on the roof at the warehouse"),
        u('CUSTOMER', "it's for the shop, the rooftop ones, we've got three of them"),
        u('AGENT', "so this is on the commercial side, the RTUs at your—at the second location"),
      ],
    },
    {
      code: 'Ductless Mini-Split',
      lines: [
        u('CUSTOMER', 'the little wall units, the ones in the addition'),
        u('CUSTOMER', "we don't have ducts back there, it's the wall-mounted thing"),
        u('AGENT', 'right, the mini-split in the converted garage'),
      ],
    },
    {
      code: 'Water Heater',
      lines: [
        u('CUSTOMER', "it's the hot water, the tank in the basement"),
        u('CUSTOMER', "we're getting maybe ten minutes of hot water and then it's done"),
        u('AGENT', 'okay so this is the water heater, not the furnace'),
      ],
    },
    {
      code: 'Air Quality',
      lines: [
        u('CUSTOMER', 'the filtration thing you added last spring'),
        u('CUSTOMER', "it's the air purifier setup, my daughter's asthma"),
        u('AGENT', 'the IAQ system, the media filter and the UV'),
      ],
    },
  ],

  reasons: [
    {
      code: 'no_cooling',
      label: 'System not cooling',
      lines: [
        u('CUSTOMER', "it's blowing but it's blowing warm, it's been like this since Sunday"),
        u('CUSTOMER', "it's seventy-nine in here right now and the thing is just running constantly"),
        u('CUSTOMER', "the air's coming out but there's nothing cold about it"),
      ],
    },
    {
      code: 'no_heat',
      label: 'System not heating',
      lines: [
        u('CUSTOMER', "we woke up and it was fifty-something in the house, nothing's coming on"),
        u('CUSTOMER', "the thing clicks and then nothing, no heat at all"),
        u('CUSTOMER', "we've got space heaters going in two rooms right now, that's where we're at"),
      ],
    },
    {
      code: 'noise_complaint',
      label: 'Abnormal noise',
      lines: [
        u('CUSTOMER', "there's this noise, kind of a grinding, every time it kicks on"),
        u('CUSTOMER', "it's making a sound like— I don't know how to describe it, like a rattle but deeper"),
        u('CUSTOMER', "you can hear it from upstairs, that's how loud it's gotten"),
      ],
    },
    {
      code: 'maintenance_renewal',
      label: 'Maintenance plan renewal',
      lines: [
        u('CUSTOMER', 'I got a letter about the service plan coming up'),
        u('CUSTOMER', 'the yearly thing, the one where you come out twice, is that auto-renewing or'),
        u('CUSTOMER', "I want to talk about whether we're keeping the coverage on this"),
      ],
    },
    {
      code: 'billing_dispute',
      label: 'Billing dispute',
      lines: [
        u('CUSTOMER', "there's a charge on here I don't recognize at all"),
        u('CUSTOMER', 'I got billed twice for the same visit, that\'s what this is about'),
        u('CUSTOMER', "the invoice doesn't match what the tech told me it'd be"),
      ],
    },
    {
      code: 'install_quote',
      label: 'New install quote',
      lines: [
        u('CUSTOMER', "we're looking at replacing the whole thing, it's nineteen years old"),
        u('CUSTOMER', 'I want to get a number on what a new system runs'),
        u('CUSTOMER', "the tech said last time it's on borrowed time so we're planning ahead"),
      ],
    },
    {
      code: 'warranty_claim',
      label: 'Warranty claim',
      lines: [
        u('CUSTOMER', "this should still be covered, you put it in two years ago"),
        u('CUSTOMER', "isn't there a ten year on the compressor? That's what we were told"),
        u('CUSTOMER', "I'm calling because the part failed and it's supposed to be under warranty"),
      ],
    },
  ],

  objections: [
    {
      code: 'price_too_high',
      label: 'Price objection',
      lines: [
        u('CUSTOMER', "okay that's— that's a lot more than I had in my head"),
        u('CUSTOMER', "yeah no, that number's rough. That's rough."),
        u('CUSTOMER', "for a capacitor? I'm sorry, that just seems like a lot for what it is"),
      ],
    },
    {
      code: 'wait_time',
      label: 'Wait time objection',
      lines: [
        u('CUSTOMER', "Thursday? It's ninety-four degrees. I can't do Thursday."),
        u('CUSTOMER', "that's five days out, I mean, is there nothing before that"),
        u('CUSTOMER', "we called Monday and now we're talking about next week, that's the part I don't get"),
      ],
    },
    {
      code: 'already_paid',
      label: 'Disputes charge already settled',
      lines: [
        u('CUSTOMER', 'I already paid this one, I have the confirmation right here'),
        u('CUSTOMER', "this was settled in March, I don't know why it's showing up again"),
      ],
    },
    {
      code: 'shopping_around',
      label: 'Comparing quotes',
      lines: [
        u('CUSTOMER', "I'm getting a couple numbers before I decide anything"),
        u('CUSTOMER', "I want to see what else is out there before I sign something like that"),
      ],
    },
    {
      code: 'needs_approval',
      label: 'Needs another decision-maker',
      lines: [
        u('CUSTOMER', "I can't green-light that on my own, my wife handles the— we decide that together"),
        u('CUSTOMER', 'I have to run it past my business partner before anything happens'),
      ],
    },
  ],

  outcomes: [
    {
      code: 'follow_up_scheduled',
      lines: [
        u('AGENT', "okay I've got you down, we'll get somebody out there"),
        u('AGENT', "I'm putting you on the board, you'll get a text with the window"),
      ],
    },
    {
      code: 'resolved',
      lines: [
        u('AGENT', "okay, that's cleared on my end, you should see it drop off"),
        u('AGENT', "so we got it reset and it's running, you're all set"),
        u('CUSTOMER', "oh — it just kicked on. Okay. We're good, I think we're good."),
      ],
    },
    {
      code: 'escalated',
      lines: [
        u('AGENT', "I'm going to hand this to my service manager, she'll own it from here"),
        u('AGENT', "this is above what I can approve, I'm routing it up"),
      ],
    },
    {
      code: 'churn_risk',
      lines: [
        u('CUSTOMER', "honestly I think we're done, I'll take the plan off"),
        u('CUSTOMER', "cancel the coverage, I'll find somebody else for this"),
      ],
    },
    {
      code: 'sale_closed',
      lines: [
        u('AGENT', "perfect, I'll write it up and get the deposit link over to you"),
        u('CUSTOMER', "yeah okay let's do it, book it"),
      ],
    },
    {
      code: 'no_action',
      lines: [
        u('CUSTOMER', "let me think about it and I'll call you back"),
        u('AGENT', "okay, no problem, we'll leave it there for now"),
      ],
    },
  ],

  competitorLines: (c) => [
    u('CUSTOMER', `${c} quoted me something pretty different, I'll be honest`),
    u('CUSTOMER', `I had ${c} out here last week for a second opinion`),
    u('CUSTOMER', `my neighbor uses ${c} and she says they came same-day`),
  ],

  disclosure: [
    u('AGENT', 'and just so you know, this call is recorded for quality and training'),
    u('AGENT', "before we go further I have to let you know we do record these, that's alright?"),
    u('AGENT', "quick note that this line is monitored and recorded, okay, so — where were we"),
  ],

  escalation: [
    u('CUSTOMER', 'can I talk to a supervisor please'),
    u('CUSTOMER', "is there a manager there, because this isn't going anywhere"),
    u('CUSTOMER', "I'd like to speak to whoever's above you on this"),
  ],

  sentiment: {
    positive: [
      u('CUSTOMER', "no you've been great, honestly, thank you"),
      u('CUSTOMER', 'I appreciate you actually looking that up'),
    ],
    neutral: [u('CUSTOMER', 'okay. Okay, that works.'), u('CUSTOMER', "alright, that's fine")],
    negative: [
      u('CUSTOMER', "this is the third time I'm explaining this, I'm getting a little tired of it"),
      u('CUSTOMER', "I don't want to be difficult but this has been a mess"),
    ],
  },

  amount: (a) => [
    u('AGENT', `so you're looking at ${a} for the whole thing, parts and labor`),
    u('AGENT', `the estimate comes to ${a}, that's before the plan discount`),
    u('CUSTOMER', `the paper he left says ${a}, is that right?`),
  ],

  commitment: (d) => [
    u('AGENT', `I can get somebody there ${d}`),
    u('AGENT', `${d} is my first opening, morning window`),
    u('AGENT', `let's say ${d}, and I'll call you if anything opens sooner`),
  ],

  filler: [
    u('AGENT', 'bear with me one second, my screen is being slow'),
    u('AGENT', 'and can I get the service address on that'),
    u('CUSTOMER', "it's the same one you have, we haven't moved"),
    u('AGENT', "okay I'm pulling it up now"),
    u('CUSTOMER', 'sorry, one sec — [dog barking] — okay go ahead'),
    u('AGENT', "and is this the best number to reach you at"),
  ],

  greeting: (a) => [
    u('AGENT', `thanks for calling Meridian Comfort Systems, this is ${a}, how can I help`),
    u('AGENT', `Meridian Comfort, ${a} speaking`),
    u('AGENT', `this is ${a} at Meridian, what can I do for you today`),
  ],

  closing: [
    u('AGENT', 'alright, anything else I can help with'),
    u('CUSTOMER', 'no that\'s it, thanks'),
    u('AGENT', 'okay, you take care'),
  ],
};

// ---------------------------------------------------------------------------
// Insurance claims intake
// ---------------------------------------------------------------------------

const CLAIMS: VerticalSpec = {
  id: 'claims',
  company: 'Northbrook Mutual',
  agentNames: ['Alan', 'Yvette', 'Deshawn', 'Nora', 'Cliff', 'Imani'],
  competitors: ['Sentinel General', 'Harbor Point', 'Cascadia Mutual'],

  productLines: [
    {
      code: 'Auto Collision',
      lines: [
        u('CUSTOMER', "it's the car, somebody came into the back of me at a light"),
        u('CUSTOMER', 'the vehicle, the Corolla, the one on the policy'),
        u('AGENT', "so this is under your auto coverage, the collision piece"),
      ],
    },
    {
      code: 'Homeowners Property',
      lines: [
        u('CUSTOMER', "the house — water came through the ceiling in the back bedroom"),
        u('CUSTOMER', "it's storm damage, the whole side of the roof"),
        u('AGENT', "okay, this falls under the dwelling coverage on the homeowners"),
      ],
    },
    {
      code: 'Renters',
      lines: [
        u('CUSTOMER', "it's the apartment, my stuff, the building's insurance says not them"),
        u('AGENT', "you're on a renters policy, so we're looking at personal property here"),
      ],
    },
    {
      code: 'Personal Umbrella',
      lines: [
        u('CUSTOMER', 'the amount is over what the auto covers, that\'s why I\'m calling'),
        u('AGENT', "this would go to the umbrella, above the underlying limit"),
      ],
    },
    {
      code: 'Small Business Property',
      lines: [
        u('CUSTOMER', "it's the shop, we had a break-in Saturday night"),
        u('AGENT', "so this is the commercial policy, the one for the storefront"),
      ],
    },
  ],

  reasons: [
    {
      code: 'new_claim',
      label: 'Reporting a new claim',
      lines: [
        u('CUSTOMER', "I need to report something that happened, uh, Tuesday night"),
        u('CUSTOMER', "I haven't filed anything yet, this is the first call"),
        u('CUSTOMER', "I'm not sure what I'm supposed to do first, this hasn't happened to me before"),
      ],
    },
    {
      code: 'status_check',
      label: 'Checking claim status',
      lines: [
        u('CUSTOMER', "I filed three weeks ago and I haven't heard anything since"),
        u('CUSTOMER', "just trying to find out where this is sitting"),
        u('CUSTOMER', "the last update I got was the fourteenth and then nothing"),
      ],
    },
    {
      code: 'adjuster_dispute',
      label: 'Dispute with adjuster',
      lines: [
        u('CUSTOMER', "the guy who came out spent maybe eleven minutes here, I timed it"),
        u('CUSTOMER', "whatever he wrote down doesn't match what's actually damaged"),
        u('CUSTOMER', "he never went in the attic, that's where most of it is"),
      ],
    },
    {
      code: 'coverage_question',
      label: 'Coverage question',
      lines: [
        u('CUSTOMER', "I'm trying to understand if this is even covered before I file"),
        u('CUSTOMER', "does the policy do anything for this or am I on my own"),
      ],
    },
    {
      code: 'total_loss',
      label: 'Total loss settlement',
      lines: [
        u('CUSTOMER', "they're calling it a total, so now what"),
        u('CUSTOMER', 'the number they put on the car is nowhere near what I can replace it for'),
      ],
    },
    {
      code: 'deductible_dispute',
      label: 'Deductible dispute',
      lines: [
        u('CUSTOMER', "I was told five hundred and now the letter says fifteen"),
        u('CUSTOMER', "why is the deductible different than what's on my declarations page"),
      ],
    },
  ],

  objections: [
    {
      code: 'settlement_too_low',
      label: 'Settlement amount too low',
      lines: [
        u('CUSTOMER', "there is no way I'm replacing that for what you're offering"),
        u('CUSTOMER', "I priced it out, it's not close. It's not close."),
      ],
    },
    {
      code: 'coverage_denied',
      label: 'Disputes a denial',
      lines: [
        u('CUSTOMER', "I've paid in for eleven years and the one time I need it, it's excluded"),
        u('CUSTOMER', "nobody ever explained that exclusion to me when I bought this"),
      ],
    },
    {
      code: 'delay_frustration',
      label: 'Frustrated with delays',
      lines: [
        u('CUSTOMER', "it's been five weeks. Five weeks."),
        u('CUSTOMER', "every time I call somebody says somebody else has it"),
      ],
    },
    {
      code: 'documentation_burden',
      label: 'Documentation burden',
      lines: [
        u('CUSTOMER', "you're asking for receipts for things I bought in 2014"),
        u('CUSTOMER', "I've sent that form twice already, to two different people"),
      ],
    },
    {
      code: 'wants_supervisor',
      label: 'Escalation demand as objection',
      lines: [
        u('CUSTOMER', "I don't think you have the authority to fix this, respectfully"),
        u('CUSTOMER', "I need somebody who can actually change the number"),
      ],
    },
  ],

  outcomes: [
    {
      code: 'follow_up_scheduled',
      lines: [
        u('AGENT', "I'm setting a callback, somebody will reach out to you"),
        u('AGENT', "we'll have a re-inspection ordered and they'll contact you to schedule"),
      ],
    },
    {
      code: 'resolved',
      lines: [
        u('AGENT', "okay, I updated it on my end and released the payment"),
        u('AGENT', "I was able to correct that, you'll see the revised letter"),
      ],
    },
    {
      code: 'escalated',
      lines: [
        u('AGENT', "I'm escalating this to a claims supervisor"),
        u('AGENT', "this is going to a review queue, I'm flagging it as a complaint"),
      ],
    },
    {
      code: 'churn_risk',
      lines: [
        u('CUSTOMER', "I'm moving both policies as soon as this is done"),
        u('CUSTOMER', "after this I'm shopping the whole thing, the auto and the house"),
      ],
    },
    { code: 'sale_closed', lines: [u('CUSTOMER', "fine, add the endorsement, let's just get it done")] },
    {
      code: 'no_action',
      lines: [
        u('CUSTOMER', "let me get the paperwork together and I'll call back"),
        u('AGENT', "okay, nothing to file today then"),
      ],
    },
  ],

  competitorLines: (c) => [
    u('CUSTOMER', `${c} quoted me forty dollars less a month for the same coverage`),
    u('CUSTOMER', `my brother's with ${c} and they cut him a check in nine days`),
    u('CUSTOMER', `I already started an application with ${c}, I'll be honest with you`),
  ],

  disclosure: [
    u('AGENT', 'I do need to let you know this call may be recorded'),
    u('AGENT', "and this is a recorded line, just so you're aware"),
    u('AGENT', 'quick disclosure — this call is recorded and anything you tell me becomes part of the claim file'),
  ],

  escalation: [
    u('CUSTOMER', 'put me through to a supervisor'),
    u('CUSTOMER', "I want this escalated, formally"),
    u('CUSTOMER', "who's your manager, I want a name"),
  ],

  sentiment: {
    positive: [
      u('CUSTOMER', "you're the first person who's actually explained this, thank you"),
      u('CUSTOMER', 'okay, that helps. That actually helps a lot.'),
    ],
    neutral: [u('CUSTOMER', 'understood.'), u('CUSTOMER', 'okay, go ahead')],
    negative: [
      u('CUSTOMER', "I'm sorry, I'm just— this has been a nightmare"),
      u('CUSTOMER', "you can hear it in my voice, I'm at the end of it"),
    ],
  },

  amount: (a) => [
    u('AGENT', `the current offer on file is ${a}`),
    u('CUSTOMER', `they sent me ${a}, that's the whole thing`),
    u('AGENT', `I'm showing a reserve of ${a} on this claim`),
  ],

  commitment: (d) => [
    u('AGENT', `you'll hear from the adjuster by ${d}`),
    u('AGENT', `I've got the review scheduled for ${d}`),
    u('AGENT', `give it until ${d} and if nothing, call me back directly`),
  ],

  filler: [
    u('AGENT', 'can I get the claim number, or the policy if you have it'),
    u('CUSTOMER', "hang on, it's on the letter somewhere"),
    u('AGENT', 'and can you verify the last four of the policyholder social'),
    u('AGENT', "okay, thank you, I've got the file open"),
    u('CUSTOMER', "[traffic noise] sorry, I'm in the car, can you hear me"),
    u('AGENT', "and the date of loss on this, do you have that"),
  ],

  greeting: (a) => [
    u('AGENT', `Northbrook Mutual claims, this is ${a}`),
    u('AGENT', `thank you for calling Northbrook, ${a} speaking, can I get your claim number`),
    u('AGENT', `claims department, ${a}, how can I help you`),
  ],

  closing: [
    u('AGENT', "is there anything else on this today"),
    u('CUSTOMER', "no, that's everything"),
    u('AGENT', "alright. Thank you for calling Northbrook."),
  ],
};

// ---------------------------------------------------------------------------
// SaaS renewal & support
// ---------------------------------------------------------------------------

const SAAS: VerticalSpec = {
  id: 'saas',
  company: 'Latchkey',
  agentNames: ['Sam', 'Bea', 'Kwame', 'Lena', 'Ford', 'Aisha'],
  competitors: ['Northwind Ops', 'Cadence', 'Relay Systems'],

  productLines: [
    {
      code: 'Core Platform',
      lines: [
        u('CUSTOMER', "the main product, the workspace, whatever you call it internally"),
        u('AGENT', "so this is on the core plan, the base seats"),
      ],
    },
    {
      code: 'Analytics Add-on',
      lines: [
        u('CUSTOMER', "the reporting module, the one we added in the spring"),
        u('AGENT', "you're on the analytics package on top of core"),
      ],
    },
    {
      code: 'Enterprise SSO',
      lines: [
        u('CUSTOMER', "the Okta thing, the single sign-on piece"),
        u('AGENT', "this is the SSO entitlement, that's an enterprise-tier feature"),
      ],
    },
    {
      code: 'API Tier',
      lines: [
        u('CUSTOMER', "we're hitting limits on the API, the programmatic access"),
        u('AGENT', "you're on the standard API tier, that's fifty thousand calls"),
      ],
    },
    {
      code: 'Onboarding Services',
      lines: [
        u('CUSTOMER', "the implementation package, the one with the dedicated person"),
        u('AGENT', "that's under professional services, the onboarding SOW"),
      ],
    },
  ],

  reasons: [
    {
      code: 'renewal_discussion',
      label: 'Renewal conversation',
      lines: [
        u('CUSTOMER', "we're up at the end of the quarter and I want to talk about it"),
        u('CUSTOMER', "your renewals person emailed me twice, so, here I am"),
        u('CUSTOMER', "before we sign another year I have some things I want to go through"),
      ],
    },
    {
      code: 'seat_expansion',
      label: 'Adding seats',
      lines: [
        u('CUSTOMER', "we're bringing on eleven people in ops and they all need access"),
        u('CUSTOMER', "I need to add licenses, what does that look like mid-term"),
      ],
    },
    {
      code: 'bug_report',
      label: 'Reporting a defect',
      lines: [
        u('CUSTOMER', "the export is producing empty files, has been since the update"),
        u('CUSTOMER', "something broke on your end Thursday and it's still broken"),
        u('CUSTOMER', "my team can't save anything, it just spins"),
      ],
    },
    {
      code: 'integration_help',
      label: 'Integration support',
      lines: [
        u('CUSTOMER', "we're trying to get this talking to Salesforce and it's not going well"),
        u('CUSTOMER', "the webhook fires but nothing lands on our side"),
      ],
    },
    {
      code: 'cancellation_request',
      label: 'Cancellation request',
      lines: [
        u('CUSTOMER', "I need to understand what it takes to not renew"),
        u('CUSTOMER', "we've made a decision internally and I'm calling to start that process"),
      ],
    },
    {
      code: 'invoice_question',
      label: 'Billing question',
      lines: [
        u('CUSTOMER', "the invoice this month is about double and nobody can tell me why"),
        u('CUSTOMER', "we got charged for seats we deactivated in June"),
      ],
    },
  ],

  objections: [
    {
      code: 'price_increase',
      label: 'Price increase objection',
      lines: [
        u('CUSTOMER', "an eighteen percent uplift with no new functionality is a hard sell internally"),
        u('CUSTOMER', "I can't take that number to my CFO, I just can't"),
      ],
    },
    {
      code: 'missing_feature',
      label: 'Missing capability',
      lines: [
        u('CUSTOMER', "we've been asking for bulk edit for two years now"),
        u('CUSTOMER', "the thing we actually needed never shipped, that's the issue"),
      ],
    },
    {
      code: 'support_history',
      label: 'Poor support history',
      lines: [
        u('CUSTOMER', "we had a P1 open for nine days in March, that's still in the room"),
        u('CUSTOMER', "every ticket we file goes into a hole"),
      ],
    },
    {
      code: 'budget_freeze',
      label: 'Budget constraint',
      lines: [
        u('CUSTOMER', "everything's frozen until the new fiscal year, that's out of my hands"),
        u('CUSTOMER', "there's a spend review on anything over ten thousand right now"),
      ],
    },
    {
      code: 'champion_left',
      label: 'Internal champion departed',
      lines: [
        u('CUSTOMER', "the person who bought this left in January and I inherited it"),
        u('CUSTOMER', "nobody here really owns this tool anymore, honestly"),
      ],
    },
  ],

  outcomes: [
    {
      code: 'follow_up_scheduled',
      lines: [
        u('AGENT', "let's get time with your solutions architect, I'll send an invite"),
        u('AGENT', "I'll put something on the calendar with our renewals lead"),
      ],
    },
    {
      code: 'resolved',
      lines: [
        u('AGENT', "okay, I pushed the fix to your workspace, try it now"),
        u('AGENT', "I credited it back, you'll see it on the next invoice"),
      ],
    },
    {
      code: 'escalated',
      lines: [
        u('AGENT', "I'm pulling in our VP of customer success on this one"),
        u('AGENT', "I'm raising this internally as a churn escalation today"),
      ],
    },
    {
      code: 'churn_risk',
      lines: [
        u('CUSTOMER', "I'll be straight with you, we're probably not renewing"),
        u('CUSTOMER', "we've already scoped the migration, that's where we are"),
      ],
    },
    {
      code: 'sale_closed',
      lines: [
        u('AGENT', "great — I'll get the order form over this afternoon"),
        u('CUSTOMER', "send it, I'll sign it today"),
      ],
    },
    {
      code: 'no_action',
      lines: [
        u('CUSTOMER', "I'll take it back to the team and we'll see"),
        u('AGENT', "no worries, I'll follow up in a few weeks"),
      ],
    },
  ],

  competitorLines: (c) => [
    u('CUSTOMER', `${c} is coming in at about sixty percent of your number`),
    u('CUSTOMER', `we ran a bake-off and ${c} won on the reporting side`),
    u('CUSTOMER', `two people on my team used ${c} at their last company and they keep bringing it up`),
  ],

  disclosure: [
    u('AGENT', "heads up that I'm recording this for our notes, that okay?"),
    u('AGENT', 'this call is being recorded and transcribed for account records'),
    u('AGENT', 'standard note — we record support calls, you can ask me to stop any time'),
  ],

  escalation: [
    u('CUSTOMER', "I'd like this in front of someone at your leadership level"),
    u('CUSTOMER', "can you get your manager on this call"),
    u('CUSTOMER', "escalate it, please"),
  ],

  sentiment: {
    positive: [
      u('CUSTOMER', "honestly that's a better answer than I expected, appreciate it"),
      u('CUSTOMER', "okay, good. That's good."),
    ],
    neutral: [u('CUSTOMER', 'sure.'), u('CUSTOMER', "okay, noted")],
    negative: [
      u('CUSTOMER', "I'm going to be blunt, this has not been a good year with you all"),
      u('CUSTOMER', "you're asking me to pay more for something that's gotten worse"),
    ],
  },

  amount: (a) => [
    u('AGENT', `the renewal comes in at ${a} annually`),
    u('CUSTOMER', `you're asking ${a} and that's the part I'm stuck on`),
    u('AGENT', `so the delta is ${a} over the current term`),
  ],

  commitment: (d) => [
    u('AGENT', `I'll have the revised quote to you by ${d}`),
    u('AGENT', `let's reconvene ${d} with your CFO on the line`),
    u('AGENT', `engineering's targeting ${d} for that fix`),
  ],

  filler: [
    u('AGENT', 'can I get the account name, or the workspace URL'),
    u('CUSTOMER', "it's under the parent company, not the DBA"),
    u('AGENT', "one sec, our own tool is loading slowly, which, I'm aware of the irony"),
    u('CUSTOMER', "[typing] okay I'm looking at it now"),
    u('AGENT', "and you're the admin on the account, right"),
    u('CUSTOMER', "I'm on a plane at four so if we get cut off that's why"),
  ],

  greeting: (a) => [
    u('AGENT', `Latchkey support, this is ${a}`),
    u('AGENT', `hey, ${a} with Latchkey, thanks for holding`),
    u('AGENT', `this is ${a} on the Latchkey team, what's going on`),
  ],

  closing: [
    u('AGENT', "anything else before I let you go"),
    u('CUSTOMER', "nope, that's it"),
    u('AGENT', "alright, talk soon"),
  ],
};

export const SPECS: Record<Vertical, VerticalSpec> = {
  hvac: HVAC,
  claims: CLAIMS,
  saas: SAAS,
};
