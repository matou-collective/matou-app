<template>
  <q-page class="community-guidelines-page">
    <!-- Header -->
    <OnboardingHeader
      title="Community Guidelines"
      subtitle="Our shared values and expectations for participation in the Matou community"
      :show-back-button="true"
      @back="onBack"
    />

    <div class="max-w-4xl mx-auto p-6 md:p-8">
      <!-- Content -->
      <div class="prose prose-lg max-w-none space-y-6">
        <!-- Introduction -->
        <section class="p-6">
          <h2 class="text-2xl font-semibold mb-4">Welcome to Matou</h2>
          <p class="text-muted-foreground mb-4">
            Matou is an indigenous-led digital community built for the purpose of open innovation and collaboration to support data sovereignty and community autonomy. We're creating a space where people can participate in meaningful governance, contribute to projects, and build lasting connections.
          </p>
        </section>

        <!-- Our Values, Community Goals, Member Expectations (shared component) -->
        <section>
          <MatouInformationContent
            :show-about="false"
            :use-animations="false"
          />
        </section>

        <!-- Code of Conduct -->
        <h2 class="text-2xl font-semibold mb-4">Code of Conduct</h2>
        <section class="content-card bg-card border border-border rounded-xl p-6">
          <div class="space-y-4 text-muted-foreground">
            <p>
              All members are expected to treat each other with respect, dignity, and kindness. We do not tolerate harassment, discrimination, or harmful behavior of any kind. Disagreements are natural and expected, but they must be handled constructively and respectfully.
            </p>
            <p>
              When participating in governance, discussions, or collaborative work, members should:
            </p>
            <ul class="list-disc list-inside space-y-2 ml-4">
              <li>Listen actively and consider diverse perspectives</li>
              <li>Communicate clearly and constructively</li>
              <li>Respect cultural differences and practices</li>
              <li>Focus on solutions rather than problems</li>
              <li>Support the collective decision-making process</li>
            </ul>
          </div>
        </section>

        <!-- Governance Participation -->
        <h2 class="text-2xl font-semibold mb-4">Governance Participation</h2>
        <section class="content-card bg-card border border-border rounded-xl p-6">
          <p class="text-muted-foreground mb-4">
            Matou operates through decentralized governance where community members can propose, discuss, and vote on decisions. Participation in governance is encouraged but not required. When you do participate:
          </p>
          <ul class="space-y-2 text-muted-foreground ml-4 list-disc">
            <li>Read proposals thoroughly before voting</li>
            <li>Engage in discussions with respect and good faith</li>
            <li>Consider the long-term impact on the community</li>
            <li>Support decisions made through the governance process</li>
          </ul>
        </section>

        <!-- Consequences -->
        <h2 class="text-2xl font-semibold mb-4">Consequences of Violations</h2>
        <section class="content-card bg-card border border-border rounded-xl p-6">
          <p class="text-muted-foreground">
            Violations of these guidelines may result in warnings, temporary restrictions, or removal from the community, depending on the severity and nature of the violation. The community governance system will handle violations through transparent processes that respect all parties involved.
          </p>
        </section>

        <!-- Contact -->
        <h2 class="text-2xl font-semibold mb-4">Questions or Concerns?</h2>
        <section class="content-card bg-card border border-border rounded-xl p-6">
          <p class="text-muted-foreground">
            If you have questions about these guidelines or need to report a concern, please reach out through the community governance channels or contact administrators via contact@matou.nz.
          </p>
        </section>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import OnboardingHeader from 'components/onboarding/OnboardingHeader.vue';
import MatouInformationContent from 'components/onboarding/MatouInformationContent.vue';

const router = useRouter();
function onBack() {
  router.back();
}
</script>

<style lang="scss" scoped>
.community-guidelines-page {
  background-color: var(--matou-background);
  min-height: calc(100vh - var(--titlebar-height));
}

h1, h2, h3 {
  color: var(--matou-foreground);
}

.prose {
  h2 {
    margin-top: 2rem;
    margin-bottom: 1rem;
  }
  
  p {
    line-height: 1.7;
  }
}
</style>
