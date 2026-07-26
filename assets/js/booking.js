const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Escape user-controlled strings before they go into innerHTML or into
// double-quoted attribute values built by concatenation. Names, display
// names, and specialties are set by self-registered users / providers, so
// any value that reaches the DOM as markup must pass through here. Escapes
// the five HTML-significant characters (incl. both quote styles), which is
// safe for text nodes and for value="..." attributes alike.
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Shared by all three portals — a student cancelling their own booking, a
// provider cancelling one of theirs, an admin cancelling any. RLS decides
// who's actually allowed; this just flips the status. Cancelled bookings
// are excluded from the DB's no-overlap constraint, so the slot opens back
// up for booking immediately. Cancelling does NOT refund a paid booking —
// Square refunds are a manual dashboard action — hence the stronger
// warning when a payment has already gone through.
async function cancelBooking(bookingId, isPaid) {
  const message = isPaid
    ? "Cancel this booking? It's already PAID — cancelling here does not issue a refund. Refunds are handled separately in Square."
    : "Cancel this booking? The time slot will open back up for others.";
  if (!confirm(message)) return false;
  const { error } = await supabaseClient
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId);
  if (error) {
    alert("Couldn't cancel this booking: " + error.message);
    return false;
  }
  return true;
}

function formatTime(hhmmss) {
  const [h, m] = hhmmss.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return hour12 + ":" + String(m).padStart(2, "0") + " " + period;
}

function formatDateTime(date) {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) +
    " · " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Expands a provider's recurring weekly availability into concrete open
// slots over the next `daysAhead` days, sized to the service duration, with
// already-booked (pending/confirmed) ranges and past times excluded.
function generateOpenSlots(availabilityRows, existingBookings, serviceDurationMinutes, daysAhead) {
  daysAhead = daysAhead || 14;
  const now = new Date();
  const slots = [];

  for (let i = 0; i < daysAhead; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const dow = day.getDay();
    const windowsForDay = availabilityRows.filter(function (a) {
      return a.is_recurring && a.day_of_week === dow;
    });

    windowsForDay.forEach(function (window_) {
      const [sh, sm] = window_.start_time.split(":").map(Number);
      const [eh, em] = window_.end_time.split(":").map(Number);
      const windowStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
      const windowEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);

      let cursor = new Date(windowStart);
      while (cursor.getTime() + serviceDurationMinutes * 60000 <= windowEnd.getTime()) {
        const slotEnd = new Date(cursor.getTime() + serviceDurationMinutes * 60000);
        if (cursor > now) {
          const overlaps = existingBookings.some(function (b) {
            const bs = new Date(b.slot_start), be = new Date(b.slot_end);
            return cursor < be && slotEnd > bs;
          });
          if (!overlaps) slots.push({ start: new Date(cursor), end: slotEnd, providerId: window_.provider_id });
        }
        cursor = new Date(cursor.getTime() + serviceDurationMinutes * 60000);
      }
    });
  }

  slots.sort(function (a, b) { return a.start - b.start; });
  return slots;
}

// Buckets the flat slot list from generateOpenSlots into per-day groups so a
// booking UI can show a row of dates and then times within the chosen date.
// Returns [{ key, date, slots }] in chronological order.
function groupSlotsByDay(slots) {
  const groups = [];
  const byKey = {};
  slots.forEach(function (slot) {
    const key = slot.start.toDateString();
    if (!byKey[key]) {
      byKey[key] = { key: key, date: slot.start, slots: [] };
      groups.push(byKey[key]);
    }
    byKey[key].slots.push(slot);
  });
  return groups;
}
