import admin from "firebase-admin";

const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

const TASK_ICONS = {
    "Food": "🥣",
    "Fresh Water": "💧",
    "Morning Walk": "🚶",
    "Evening Walk": "🌆",
    "Medicine": "💊",
    "Grooming": "🧼"
};

function getIndiaTime() {
    const now = new Date();

    const parts = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).formatToParts(now);

    const get = (type) =>
        parts.find((p) => p.type === type)?.value;

    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}`
    };
}

function minutesFromTime(time) {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
}

async function getFamilyTokens(familyId) {
    const membersSnap = await db
        .collection("families")
        .doc(familyId)
        .collection("members")
        .get();

    const tokens = [];

    for (const member of membersSnap.docs) {
        const userSnap = await db
            .collection("users")
            .doc(member.id)
            .get();

        if (!userSnap.exists) {
            continue;
        }

        const user = userSnap.data();

        if (
            user.notificationsEnabled === true &&
            user.fcmToken
        ) {
            tokens.push(user.fcmToken);
        }
    }

    return [...new Set(tokens)];
}

async function sendNotification(
    tokens,
    title,
    body,
    tag
) {
    if (!tokens.length) {
        console.log("No notification tokens found.");
        return;
    }

    const message = {
        tokens: tokens,

        notification: {
            title: title,
            body: body
        },

        data: {
            tag: tag
        },

        webpush: {
            notification: {
                title: title,
                body: body,
                tag: tag
            }
        }
    };

    const response =
        await messaging.sendEachForMulticast(message);

    console.log(
        `Notification sent: ${response.successCount} successful, ${response.failureCount} failed`
    );
}

async function processPet(
    familyId,
    petId,
    petName
) {
    console.log(
        `Processing pet: ${petName}`
    );

    const reminderRef = db
        .collection("families")
        .doc(familyId)
        .collection("pets")
        .doc(petId)
        .collection("reminders")
        .doc("reminders");

    const reminderSnap =
        await reminderRef.get();

    if (!reminderSnap.exists) {
        console.log(
            `No reminder settings found for ${petName}`
        );
        return;
    }

    const reminders = reminderSnap.data();

    const today = getIndiaTime();

    const nowMinutes =
        minutesFromTime(today.time);

    console.log(
        `India time: ${today.date} ${today.time}`
    );

    const tasksRef = db
        .collection("families")
        .doc(familyId)
        .collection("pets")
        .doc(petId)
        .collection("days")
        .doc(today.date)
        .collection("tasks");

    const tasksSnap =
        await tasksRef.get();

    const completed = {};

    tasksSnap.forEach((taskDoc) => {
        const data = taskDoc.data();

        if (data.completed === true) {
            completed[data.taskName] = true;
        }
    });

    const tokens =
        await getFamilyTokens(familyId);

    if (!tokens.length) {
        console.log(
            `No enabled notification tokens for family ${familyId}`
        );
        return;
    }

    for (
        const [taskName, reminderTime]
        of Object.entries(reminders)
    ) {
        if (
            typeof reminderTime !== "string" ||
            !/^\d{2}:\d{2}$/.test(reminderTime)
        ) {
            continue;
        }

        if (completed[taskName]) {
            console.log(
                `${taskName}: already completed`
            );
            continue;
        }

        const dueMinutes =
            minutesFromTime(reminderTime);

        const minutesLate =
            nowMinutes - dueMinutes;

        let notificationType = "";

        if (
            minutesLate >= 0 &&
            minutesLate < 30
        ) {
            notificationType = "due";
        } else if (
            minutesLate >= 30
        ) {
            notificationType = "missed";
        } else {
            continue;
        }

        const stateRef = db
            .collection("families")
            .doc(familyId)
            .collection("pets")
            .doc(petId)
            .collection("reminders")
            .doc("notification-state");

        const stateSnap =
            await stateRef.get();

        const state =
            stateSnap.exists
                ? stateSnap.data()
                : {};

        const stateKey =
            `${taskName}_${today.date}_${notificationType}`;

        if (state[stateKey]) {
            console.log(
                `${taskName}: ${notificationType} notification already sent`
            );
            continue;
        }

        const icon =
            TASK_ICONS[taskName] || "🐾";

        let title;
        let body;

        if (notificationType === "due") {
            title =
                "PetOlife Care Reminder";

            body =
                `${icon} ${petName}'s ${taskName} is due now.`;
        } else {
            title =
                "PetOlife — Care Still Pending";

            body =
                `${icon} ${petName}'s ${taskName} is still pending. Please take care of your pet.`;
        }

        console.log(
            `Sending ${notificationType} notification for ${taskName}`
        );

        await sendNotification(
            tokens,
            title,
            body,
            `petolife-${petId}-${taskName}-${notificationType}`
        );

        await stateRef.set(
            {
                [stateKey]: true
            },
            {
                merge: true
            }
        );
    }
}

async function main() {
    console.log(
        "PetOlife reminder server started."
    );

    const reminderDocs =
        await db
            .collectionGroup("reminders")
            .get();

    console.log(
        `Found ${reminderDocs.size} reminder documents.`
    );

    const processedPets = new Set();

    for (const reminderDoc of reminderDocs.docs) {
        if (reminderDoc.id !== "reminders") {
            continue;
        }

        const pathParts =
            reminderDoc.ref.path.split("/");

        console.log(
            `Found reminder document: ${reminderDoc.ref.path}`
        );

        if (pathParts.length !== 6) {
            console.log(
                `Skipping unexpected path: ${reminderDoc.ref.path}`
            );
            continue;
        }

        const familyId = pathParts[1];
        const petId = pathParts[3];

        const petKey =
            `${familyId}/${petId}`;

        if (processedPets.has(petKey)) {
            continue;
        }

        processedPets.add(petKey);

        const petSnap =
            await db
                .collection("families")
                .doc(familyId)
                .collection("pets")
                .doc(petId)
                .get();

        if (!petSnap.exists) {
            console.log(
                `Pet not found: ${petKey}`
            );
            continue;
        }

        const pet =
            petSnap.data();

        const petName =
            pet.name || "Your pet";

        console.log(
            `Checking reminders for ${petName}`
        );

        await processPet(
            familyId,
            petId,
            petName
        );
    }

    console.log(
        "PetOlife reminder check completed."
    );
}

main().catch((error) => {
    console.error(
        "Reminder server error:",
        error
    );

    process.exit(1);
});
